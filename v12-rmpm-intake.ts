/**
 * V12 R.M.P.M INTAKE — universal drop-in receiver for the operations R.M.P.M
 * sends. Companion to `v12-feed-intake.ts`, same shape, same guarantees.
 *
 * Copy this file into any V12 app and mount it BEFORE express.json():
 *
 *     import { createRmpmIntake } from './v12-rmpm-intake.ts';
 *     app.use('/api', createRmpmIntake({ serviceId: 'ceos' }));
 *
 * Then in R.M.P.M: <APP>_BASE_URL=https://<host>/api
 *
 * Endpoints (all POST — R.M.P.M signs a body on every call, and a GET with a
 * signed body is not a thing):
 *
 *     /health              reachability; every R.M.P.M client calls it first
 *     /identity/federate   Article IX §9.5 — a handoff token for an assertion
 *     /marketable/ingest   Article XIV §14.11 — marketable product data
 *     /commission/ack      Article XIV §14.6 — we accept, or refuse and say why
 *     /commission/deliver  the finished result, with its reach figure attached
 *
 * Without this file those operations reach a 404 — and in a single-page app the
 * SPA catch-all turns that 404 into a 200 with an HTML body, so R.M.P.M's
 * client throws while parsing JSON and the error names the wrong layer
 * entirely. That failure is the reason this exists.
 *
 * Contract: `X-V12-Service` names the sender and `V12-Signature:
 * t=<unix>,v1=<hex hmac-sha256 over "t.rawBody">` proves it — the same
 * construction as v12-feed-intake.ts and v12-webhook.ts, vendored verbatim.
 *
 * Secrets: tried in order — V12_<SENDER>_WEBHOOK_SECRET,
 * V12_<SENDER>_SIGNING_SECRET, V12_<SELF>_WEBHOOK_SECRET, V12_WEBHOOK_SECRET,
 * ECOSYSTEM_SECRET, ECOSYSTEM_HMAC_SECRET. No configured secret = every
 * request refused (fail-closed). Never accept unsigned traffic.
 *
 * Self-contained: express + node built-ins only. Nothing here imports from the
 * host application, so the file is identical in every repository and a fix
 * made once is a fix everywhere.
 */
import express, { Request, Response, Router } from 'express';
import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';

// ── V12-Signature verification (vendored construction — do not alter) ───────

const SERVICE_ID_PATTERN = /^[a-z][a-z0-9-]{1,38}[a-z0-9]$/;

function verifySignature(secret: string, rawBody: string, header: string,
                         toleranceSec = 300): boolean {
  const parts = Object.fromEntries(
    header.split(',').map((kv) => kv.trim().split('=') as [string, string]));
  const t = Number(parts.t);
  if (!Number.isFinite(t) || !parts.v1) return false;
  if (Math.abs(Math.floor(Date.now() / 1000) - t) > toleranceSec) return false;
  const expected = createHmac('sha256', secret).update(`${t}.${rawBody}`).digest('hex');
  // Compared as hex TEXT of equal length. Buffer.from(hex, 'hex') on the
  // caller's half silently truncates invalid input, which can make a wrong
  // signature compare equal to a prefix of the right one.
  const a = Buffer.from(parts.v1);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

function envKey(id: string): string {
  return id.toUpperCase().replace(/-/g, '_');
}

// ── shapes ──────────────────────────────────────────────────────────────────

export interface FederatedIdentity {
  subject: string;
  organization_id: string;
  display_name?: string;
  role?: string;
  tier?: string;
  scopes?: string[];
}

export interface MarketableItem {
  id?: string;
  type?: string;
  [field: string]: unknown;
}

export interface CommissionEvent {
  phase: 'ack' | 'deliver';
  commission_id: string;
  accepted?: boolean;
  state?: string;
  detail?: string;
  reach?: Record<string, unknown>;
  journey_id?: string | null;
  correlation_id?: string;
  received_at: string;
}

export interface RmpmIntakeOptions {
  /** This app's service id, e.g. "ceos", "sociofy", "apex-atlas". */
  serviceId: string;
  /** Override secret resolution. Default: the env lookup described above. */
  secretsFor?: (senderId: string) => string[];
  /** Seconds a signature's timestamp may be out of step. Default 300. */
  toleranceSec?: number;
  /**
   * Turn a handoff token into an identity, or undefined to refuse.
   *
   * Injected, never defaulted. Identity is the host application's to decide,
   * and a default that says yes would be a back door with a ceremony in front
   * of it. Unset means every federation attempt is refused, honestly.
   */
  federate?: (handoffToken: string) => Promise<FederatedIdentity | undefined>;
  /** Persist a marketable item. Return false to count it as not stored. */
  onMarketable?: (item: MarketableItem, context: {
    surface: string; correlationId?: string;
  }) => Promise<boolean | void> | boolean | void;
  /** Persist a commission acknowledgement or delivery. */
  onCommission?: (event: CommissionEvent) => Promise<void> | void;
  /** Which senders may call at all. Default: any that has a shared secret. */
  allowedSenders?: string[];
}

export const OPERATIONS = [
  'health', 'identity/federate', 'marketable/ingest',
  'commission/ack', 'commission/deliver',
] as const;

// ── intake factory ──────────────────────────────────────────────────────────

export function createRmpmIntake(opts: RmpmIntakeOptions): Router {
  const router = Router();
  const tolerance = opts.toleranceSec ?? 300;
  const recentCommissions: CommissionEvent[] = [];
  const recentMarketable: MarketableItem[] = [];

  const secretsFor = opts.secretsFor ?? ((senderId: string) => [
    process.env[`V12_${envKey(senderId)}_WEBHOOK_SECRET`],
    process.env[`V12_${envKey(senderId)}_SIGNING_SECRET`],
    process.env[`V12_${envKey(opts.serviceId)}_WEBHOOK_SECRET`],
    process.env.V12_WEBHOOK_SECRET,
    process.env.ECOSYSTEM_SECRET,
    process.env.ECOSYSTEM_HMAC_SECRET,
  ].filter((s): s is string => typeof s === 'string' && s.length >= 32));

  /**
   * The raw parser is attached PER ROUTE, never with router.use().
   *
   * This router mounts at /api, where the host application keeps its own
   * routes. A router-wide express.raw() buffers the body of every /api request
   * that enters the router — including the ones that fall straight through to
   * the host's own handlers — and express.json() further down the stack skips
   * a request whose body has already been read. Every unrelated endpoint would
   * then receive a Buffer where it expected an object, and the failure looks
   * like a bug in those endpoints rather than in this file.
   */
  const raw = express.raw({ type: '*/*', limit: '512kb' });

  const verified = (req: Request, res: Response, next: () => void) => {
    const sender = req.headers['x-v12-service'];
    const signature = req.headers['v12-signature'];
    if (typeof sender !== 'string' || !SERVICE_ID_PATTERN.test(sender)
        || typeof signature !== 'string') {
      return res.status(401).json({
        error: 'unsigned',
        detail: 'Requires X-V12-Service and V12-Signature (t=<unix>,v1=<hex>).',
      });
    }
    if (opts.allowedSenders && !opts.allowedSenders.includes(sender)) {
      console.warn(`[rmpm-intake:${opts.serviceId}] "${sender}" is not on the allowlist`);
      return res.status(401).json({ error: 'unverifiable' });
    }

    const body = Buffer.isBuffer(req.body) ? req.body.toString('utf8') : '';
    const candidates = secretsFor(sender);
    if (!candidates.length) {
      // Distinct in the log, identical on the wire. An unconfigured secret
      // refusing everything looks exactly like a wrong secret refusing
      // everything, and only one of those is fixed by rotating a key.
      console.error(`[rmpm-intake:${opts.serviceId}] no shared secret for ` +
                    `"${sender}" — set V12_${envKey(sender)}_WEBHOOK_SECRET`);
      return res.status(401).json({ error: 'unverifiable' });
    }
    if (!candidates.some((s) => verifySignature(s, body, signature, tolerance))) {
      console.warn(`[rmpm-intake:${opts.serviceId}] signature refused from "${sender}"`);
      return res.status(401).json({ error: 'unverifiable' });
    }

    try {
      (req as any).v12Envelope = body ? JSON.parse(body) : {};
    } catch {
      return res.status(400).json({ error: 'body is not JSON' });
    }
    (req as any).v12Sender = sender;
    next();
  };

  /** R.M.P.M puts the operands in `payload` and the tenant at the top level. */
  function operands(req: Request): Record<string, any> {
    const env = (req as any).v12Envelope ?? {};
    const payload = (env && typeof env.payload === 'object' && env.payload) || {};
    return { ...env, ...payload };
  }

  // ── reachability ──────────────────────────────────────────────────────────
  router.post('/health', raw, verified, (_req: Request, res: Response) => {
    res.json({ ok: true, app: opts.serviceId, accepts: OPERATIONS,
               federation: Boolean(opts.federate) });
  });

  // ── Article IX §9.5 — identity is federated, never re-registered ──────────
  router.post('/identity/federate', raw, verified,
              async (req: Request, res: Response) => {
    const { handoff_token } = operands(req);
    if (typeof handoff_token !== 'string' || handoff_token.length < 8) {
      return res.status(422).json({ valid: false, error: 'handoff_token is required' });
    }
    if (!opts.federate) {
      console.warn(`[rmpm-intake:${opts.serviceId}] identity/federate is not wired; refusing`);
      return res.json({ valid: false,
                        error: 'federation is not configured on this deployment' });
    }
    try {
      const identity = await opts.federate(handoff_token);
      return identity ? res.json({ valid: true, ...identity })
                      : res.json({ valid: false });
    } catch (err) {
      console.error(`[rmpm-intake:${opts.serviceId}] federate failed`, err);
      return res.status(500).json({ valid: false });
    }
  });

  // ── Article XIV §14.11 — marketable product and information data ──────────
  router.post('/marketable/ingest', raw, verified,
              async (req: Request, res: Response) => {
    const body = operands(req);
    const items: MarketableItem[] = Array.isArray(body.items) ? body.items : [];
    const surface = typeof body.surface === 'string' ? body.surface : 'unspecified';
    if (!items.length) return res.status(422).json({ error: 'items[] is required' });

    let stored = 0;
    for (const item of items) {
      const withId = { id: `mkt_${randomUUID()}`, ...item };
      try {
        const verdict = await opts.onMarketable?.(withId, {
          surface, correlationId: body.correlation_id,
        });
        if (opts.onMarketable && verdict === false) continue;
        if (!opts.onMarketable) {
          recentMarketable.unshift(withId);
          recentMarketable.length = Math.min(recentMarketable.length, 200);
        }
        stored += 1;
      } catch (err) {
        console.error(`[rmpm-intake:${opts.serviceId}] could not store an item`, err);
      }
    }

    // Partial success is reported as partial success. A 200 carrying a count
    // the sender cannot act on would let a silent failure look like delivery,
    // and R.M.P.M's §14.11 duty is discharged against what was received.
    return res.status(stored === items.length ? 200 : 207)
              .json({ accepted: stored, submitted: items.length, surface });
  });

  // ── Article XIV §14.6 — the commission channel ────────────────────────────
  async function note(event: CommissionEvent) {
    if (!event.commission_id) {
      return { recorded: false, error: 'commission_id is required' };
    }
    recentCommissions.unshift(event);
    recentCommissions.length = Math.min(recentCommissions.length, 200);
    try {
      await opts.onCommission?.(event);
    } catch (err) {
      console.error(`[rmpm-intake:${opts.serviceId}] onCommission failed`, err);
      return { recorded: false, error: 'could not persist' };
    }
    return { recorded: true, commission_id: event.commission_id, phase: event.phase };
  }

  router.post('/commission/ack', raw, verified, async (req: Request, res: Response) => {
    const b = operands(req);
    res.json(await note({
      phase: 'ack', commission_id: String(b.commission_id ?? ''),
      accepted: Boolean(b.accepted), detail: String(b.detail ?? ''),
      correlation_id: b.correlation_id, received_at: new Date().toISOString(),
    }));
  });

  router.post('/commission/deliver', raw, verified,
              async (req: Request, res: Response) => {
    const b = operands(req);
    res.json(await note({
      phase: 'deliver', commission_id: String(b.commission_id ?? ''),
      state: String(b.state ?? ''),
      reach: (b.reach && typeof b.reach === 'object') ? b.reach : {},
      journey_id: b.journey_id ?? null, correlation_id: b.correlation_id,
      received_at: new Date().toISOString(),
    }));
  });

  // An operation under one of these prefixes that is not implemented gets a
  // JSON 404 that names what IS implemented. Without this the SPA catch-all
  // answers 200 with index.html and the caller fails while parsing, pointing
  // at the wrong layer.
  router.post(['/commission', '/commission/*', '/marketable', '/marketable/*',
               '/identity', '/identity/*'], raw, verified,
              (req: Request, res: Response) => {
    res.status(404).json({ error: 'unsupported_operation', path: req.path,
                           supported: OPERATIONS });
  });

  // Read-only views, for the host app to expose behind its own admin guard.
  (router as any).recentCommissions = (limit = 50) =>
    recentCommissions.slice(0, Math.max(1, Math.min(limit, 200)));
  (router as any).recentMarketable = (limit = 50) =>
    recentMarketable.slice(0, Math.max(1, Math.min(limit, 200)));

  return router;
}
