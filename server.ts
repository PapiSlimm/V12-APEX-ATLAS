/**
 * V12 Apex Atlas — API + static host
 *
 * Security posture:
 *  - Session tokens live in an httpOnly, SameSite=Strict cookie, unreadable by
 *    page scripts.
 *  - Every mutating route is authenticated, role-checked and CSRF-protected.
 *  - Trade execution re-runs the Hermes engine server-side against server-held
 *    state, and liquidation is a compare-and-swap so concurrent requests cannot
 *    sell the same inventory twice.
 *  - Every execution decision — allowed or refused — is appended to a
 *    hash-chained audit log.
 */

import express, { type NextFunction, type Request, type Response } from 'express';
import path from 'path';
import crypto from 'crypto';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import { GoogleGenAI } from '@google/genai';
import { createFeedIntake } from './v12-feed-intake';

import {
  createStore,
  createTenant,
  initialiseStore,
  DEFAULT_TENANT_ID,
  isPlan,
  type Store,
  type Tenant,
  type TenantId,
  type UserRecord,
  type UserRole,
} from './server/store';
import { authoriseSell, evaluateAsset } from './server/hermes';
import { buildGraph, fundamentalsIntact, valueEcosystem, SPEC_MANDATE, type FeeTable } from './server/twin';
import { csrfProtection, issueCsrfToken, clearCsrfToken } from './server/csrf';
import { serveSandbox } from './server/sandbox';
import {
  ExecutionService,
  plan as planExecution,
  startAssetRuntime,
  unrealisedPnl,
  round,
  type AssetSpec,
  type Position,
  type Quote,
  type AssetRuntime,
} from './server/assets';

const app = express();
const PORT = Number(process.env.PORT) || 3000;
const IS_PROD = process.env.NODE_ENV === 'production';
const COOKIE_NAME = 'apex_session';
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash';

let store: Store;
let defaultTenant!: Tenant;

/**
 * Multi-tenant signup is opt-in. The self-hosted and desktop editions run
 * single-tenant: everyone lands in the default organisation and the tenancy
 * machinery costs them one column. Cloud sets MULTI_TENANT=true.
 */
const MULTI_TENANT = process.env.MULTI_TENANT === 'true';

/**
 * Read-only public endpoints have no session, so they serve the default
 * tenant. In multi-tenant mode that is the demo book, never a customer's.
 */
const publicTenant = (req: Request): TenantId => req.user?.tenantId ?? DEFAULT_TENANT_ID;

/**
 * One trading runtime per tenant, created on demand.
 *
 * Tenants do not share a venue connection. In production each tenant has its
 * own venue credentials; commingling several customers' orders through one
 * exchange account is a regulatory and correctness failure, not a scaling
 * optimisation. The registry makes that structural rather than aspirational.
 */
const runtimes = new Map<string, AssetRuntime>();
const runtimeLocks = new Map<string, Promise<AssetRuntime>>();

async function runtimeFor(tenantId: TenantId): Promise<AssetRuntime> {
  const existing = runtimes.get(tenantId);
  if (existing) return existing;

  // Two concurrent requests for a cold tenant must not build two runtimes —
  // that would mean two reconciliations racing against the same venue.
  const pending = runtimeLocks.get(tenantId);
  if (pending) return pending;

  const building = startAssetRuntime(store, tenantId)
    .then((runtime) => {
      runtimes.set(tenantId, runtime);
      runtimeLocks.delete(tenantId);
      return runtime;
    })
    .catch((err) => {
      runtimeLocks.delete(tenantId);
      throw err;
    });

  runtimeLocks.set(tenantId, building);
  return building;
}

/** Wrap the strategy so a bad asset spec cannot take down the state endpoint. */
function planFor(instrument: AssetSpec, position: Position, quote: Quote | null) {
  try {
    return planExecution(instrument, position, quote);
  } catch (err) {
    return {
      action: 'hold' as const,
      reason: `Strategy error: ${err instanceof Error ? err.message : String(err)}`,
      zeroLossSatisfied: false,
      diagnostics: {},
    };
  }
}

// --------------------------------------------------------------------------
// Secrets
// --------------------------------------------------------------------------
const JWT_SECRET = (() => {
  const fromEnv = process.env.JWT_SECRET;
  if (fromEnv && fromEnv.length >= 32) return fromEnv;
  if (IS_PROD) {
    console.error('[fatal] JWT_SECRET must be set to a random string of at least 32 characters.');
    process.exit(1);
  }
  console.warn('[warn] JWT_SECRET not set. Using an ephemeral dev secret; sessions reset on restart.');
  return crypto.randomBytes(48).toString('hex');
})();

// --------------------------------------------------------------------------
// Middleware
// --------------------------------------------------------------------------
app.set('trust proxy', 1);
app.disable('x-powered-by');

// The sandbox route sets its own, much stricter, CSP — it must be mounted
// before helmet so helmet's app-wide policy does not overwrite it.
app.get('/repl-sandbox', serveSandbox(IS_PROD));

// Served before the SPA fallback, which would otherwise return index.html for
// /robots.txt and tell crawlers nothing.
app.get('/robots.txt', (_req, res) => {
  res.type('text/plain').send('User-agent: *\nDisallow: /\n');
});

app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        // No 'unsafe-eval' in production. Moving artifact execution into the
        // sandboxed iframe removed the last `new Function` call from this
        // origin — Babel only parses and prints, it does not evaluate. The one
        // document that can eval is now the opaque-origin sandbox, which has no
        // cookies, no storage and no network. Vite's dev server needs eval for
        // HMR, so it stays allowed in development only.
        scriptSrc: IS_PROD ? ["'self'"] : ["'self'", "'unsafe-eval'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", 'data:', 'blob:'],
        connectSrc: ["'self'"],
        frameSrc: ["'self'"],
        objectSrc: ["'none'"],
        frameAncestors: ["'none'"],
        baseUri: ["'self'"],
      },
    },
    crossOriginEmbedderPolicy: false,
  }),
);

// V12 ecosystem feed intake (SonicStream & peers). Raw-body HMAC route —
// MUST mount before express.json() and before CSRF (peers are not browsers).
// Accepted events queue in ecosystem-inbox.jsonl and GET /api/ecosystem/feed/inbox
// as Apex's admission-review queue for the Atlas Galaxy.
app.use('/api/ecosystem/feed', createFeedIntake({ serviceId: 'apexatlas' }));

app.use(express.json({ limit: '256kb' }));
app.use(cookieParser());
app.use(csrfProtection);

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many authentication attempts. Try again in 15 minutes.' },
});

const aiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Model request rate limit exceeded. Slow down.' },
});

const writeLimiter = rateLimit({ windowMs: 60 * 1000, max: 60 });

/** Wraps async handlers so a rejected promise reaches the error middleware. */
const wrap =
  (fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>) =>
  (req: Request, res: Response, next: NextFunction) => {
    void fn(req, res, next).catch(next);
  };

// --------------------------------------------------------------------------
// Gemini client
// --------------------------------------------------------------------------
let ai: GoogleGenAI | null = null;
const hasApiKey = () => Boolean(process.env.GEMINI_API_KEY);

function getGenAI(): GoogleGenAI {
  if (!ai) {
    ai = new GoogleGenAI({
      apiKey: process.env.GEMINI_API_KEY || 'unset',
      httpOptions: { headers: { 'User-Agent': 'v12-apex-atlas' } },
    });
  }
  return ai;
}

// --------------------------------------------------------------------------
// Auth
// --------------------------------------------------------------------------
interface SessionClaims {
  id: string;
  /**
   * The tenant is carried in the SESSION, never read from the request. A
   * tenantId in a request body is an attacker's field; this one is signed.
   */
  tenantId: TenantId;
  email: string;
  name: string;
  role: UserRole;
}

/** The only sanctioned way to obtain a tenant for a request. */
const tenantOf = (req: Request): TenantId => req.user!.tenantId;

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: SessionClaims;
    }
  }
}

const publicUser = (u: UserRecord) => ({
  id: u.id,
  tenantId: u.tenantId,
  email: u.email,
  name: u.name,
  role: u.role,
  createdAt: u.createdAt,
});

function issueSession(res: Response, user: UserRecord): void {
  const claims: SessionClaims = {
    id: user.id,
    tenantId: user.tenantId,
    email: user.email,
    name: user.name,
    role: user.role,
  };
  const token = jwt.sign(claims, JWT_SECRET, { expiresIn: '12h' });

  res.cookie(COOKIE_NAME, token, {
    httpOnly: true,
    secure: IS_PROD,
    sameSite: 'strict',
    maxAge: 12 * 60 * 60 * 1000,
    path: '/',
  });

  issueCsrfToken(res, IS_PROD);
}

function readToken(req: Request): string | undefined {
  const bearer = req.headers.authorization?.startsWith('Bearer ')
    ? req.headers.authorization.slice(7)
    : undefined;
  return (req.cookies?.[COOKIE_NAME] as string | undefined) || bearer;
}

function authenticate(req: Request, res: Response, next: NextFunction) {
  const token = readToken(req);
  if (!token) return res.status(401).json({ error: 'Authentication required.' });

  try {
    req.user = jwt.verify(token, JWT_SECRET) as SessionClaims;
    next();
  } catch {
    res.clearCookie(COOKIE_NAME, { path: '/' });
    clearCsrfToken(res);
    return res.status(401).json({ error: 'Session expired or invalid. Please sign in again.' });
  }
}

/**
 * Populates `req.user` when a valid session exists, but does not require one.
 *
 * This exists because of a real cross-tenant read. Routes like
 * `/api/execution/state` are deliberately unauthenticated so a signed-out
 * visitor can see the demo book — but they resolved their tenant via
 * `req.user?.tenantId ?? DEFAULT_TENANT_ID`, and with no auth middleware
 * `req.user` was ALWAYS undefined. A signed-in customer with a perfectly valid
 * cookie was therefore served the default organisation's positions, orders and
 * vault instead of their own.
 *
 * "Optional" must mean "read it if present", not "never read it".
 */
function optionalAuth(req: Request, _res: Response, next: NextFunction) {
  const token = readToken(req);
  if (!token) return next();
  try {
    req.user = jwt.verify(token, JWT_SECRET) as SessionClaims;
  } catch {
    // An invalid token on a public route is simply an anonymous visitor.
  }
  next();
}

function requireRole(...roles: UserRole[]) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!req.user) return res.status(401).json({ error: 'Authentication required.' });
    if (!roles.includes(req.user.role)) {
      // A refused privileged action is worth recording even though it changed
      // nothing — repeated refusals are the signal, not the noise.
      void store.audit
        .append(req.user.tenantId, {
          event: 'authz.denied',
          actorId: req.user.id,
          actorName: req.user.name,
          actorRole: req.user.role,
          subject: `${req.method} ${req.path}`,
          outcome: 'refused',
          detail: { required: roles },
        })
        .catch(() => undefined);

      return res.status(403).json({
        error: `Role "${req.user.role}" is not permitted to perform this action. Required: ${roles.join(' or ')}.`,
      });
    }
    next();
  };
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// --------------------------------------------------------------------------
// Health
// --------------------------------------------------------------------------
app.get(
  '/api/health',
  wrap(async (_req, res) => {
    const chain = await store.audit.verifyAll();
    const active = [...runtimes.values()];
    res.json({
      status: chain.ok && !active.some((r) => r.risk.isHalted) ? 'ok' : 'degraded',
      version: process.env.npm_package_version || '12.5.0',
      storage: store.dialect,
      geminiConfigured: hasApiKey(),
      model: GEMINI_MODEL,
      auditChain: { ok: chain.ok, tenants: chain.tenants, broken: chain.broken },
      tenants: await store.tenants.count(),
      // Surfaced so pre-flight can check the real condition rather than
      // guessing the password. Seeded credentials in production are the most
      // common way a demo becomes a breach.
      demoUsersEnabled: process.env.ENABLE_DEMO_USERS === 'true',
      multiTenant: MULTI_TENANT,
      execution: {
        activeRuntimes: active.length,
        marketplaces: [...new Set(active.map((r) => r.marketplace.id))],
        halted: active.filter((r) => r.risk.isHalted).length,
        discrepancies: active.reduce((n, r) => n + (r.lastReconciliation?.discrepancies.length ?? 0), 0),
      },
      uptimeSeconds: Math.round(process.uptime()),
    });
  }),
);

// --------------------------------------------------------------------------
// Auth routes
// --------------------------------------------------------------------------
app.post(
  '/api/auth/register',
  authLimiter,
  wrap(async (req, res) => {
    const { email, password, name, role } = req.body ?? {};

    if (typeof email !== 'string' || !EMAIL_RE.test(email)) {
      return res.status(400).json({ error: 'A valid email address is required.' });
    }
    if (typeof name !== 'string' || name.trim().length < 2 || name.length > 120) {
      return res.status(400).json({ error: 'Name must be between 2 and 120 characters.' });
    }
    if (typeof password !== 'string' || password.length < 12) {
      return res.status(400).json({ error: 'Password must be at least 12 characters.' });
    }
    if (password.length > 200) return res.status(400).json({ error: 'Password is too long.' });

    const normalised = email.trim().toLowerCase();
    if (await store.users.findByEmail(normalised)) {
      return res.status(409).json({ error: 'An account with this email already exists.' });
    }

    const allowed: UserRole[] = ['Executive', 'Arbitrage Trader', 'LoRABlender Engineer'];
    const assignedRole: UserRole = allowed.includes(role) ? role : 'LoRABlender Engineer';

    // Tenant resolution. In single-tenant mode (self-hosted, desktop) everyone
    // lands in the default tenant. In multi-tenant mode a signup either creates
    // a new organisation or is the first seat of one.
    const { organisation, plan } = req.body ?? {};
    let tenant: Tenant;

    if (MULTI_TENANT) {
      // In multi-tenant mode a signup NEVER falls through to the default
      // tenant. That default is the deployment's own organisation; dropping an
      // unknown signup into it would put a stranger inside the operator's book.
      // Without an organisation name they get a personal one of their own.
      tenant = await createTenant(store, {
        name:
          typeof organisation === 'string' && organisation.trim().length >= 2
            ? organisation
            : `${name.trim()}'s workspace`,
        plan: isPlan(plan) ? plan : 'explorer',
      });
    } else {
      // Single-tenant deployments (self-hosted, desktop) have exactly one
      // organisation and everyone joins it.
      tenant = (await store.tenants.get(DEFAULT_TENANT_ID)) ?? defaultTenant;
    }

    // Seat limits are enforced here, not in the billing system, because this is
    // the only place a seat is actually consumed.
    const seatsUsed = await store.users.countForTenant(tenant.id);
    if (seatsUsed >= tenant.seatLimit) {
      return res.status(402).json({
        error: `This organisation has used all ${tenant.seatLimit} seat(s) on the ${tenant.plan} plan.`,
        code: 'seat_limit_reached',
      });
    }

    const user: UserRecord = {
      id: `usr-${crypto.randomUUID()}`,
      tenantId: tenant.id,
      email: normalised,
      name: name.trim(),
      passwordHash: await bcrypt.hash(password, 12),
      role: assignedRole,
      createdAt: new Date().toISOString(),
    };

    await store.users.create(user);
    await store.audit.append(tenant.id, {
      event: 'auth.registered',
      actorId: user.id,
      actorName: user.name,
      actorRole: user.role,
      subject: user.email,
      outcome: 'allowed',
      detail: {},
    });

    issueSession(res, user);
    res.status(201).json({ user: publicUser(user) });
  }),
);

app.post(
  '/api/auth/login',
  authLimiter,
  wrap(async (req, res) => {
    const { email, password } = req.body ?? {};
    const normalised = typeof email === 'string' ? email.trim().toLowerCase() : '';
    const user = await store.users.findByEmail(normalised);

    // Always compare a hash so response timing does not reveal whether the
    // account exists.
    const dummy = '$2b$12$0000000000000000000000000000000000000000000000000000';
    const ok = await bcrypt.compare(
      typeof password === 'string' ? password : '',
      user?.passwordHash ?? dummy,
    );

    if (!user || !ok) {
      await store.audit.append(user?.tenantId ?? defaultTenant.id, {
        event: 'auth.login',
        actorId: user?.id ?? null,
        actorName: null,
        actorRole: null,
        subject: normalised || null,
        outcome: 'refused',
        detail: { reason: 'invalid_credentials' },
      });
      return res.status(401).json({ error: 'Invalid email or password.' });
    }

    issueSession(res, user);
    res.json({ user: publicUser(user) });
  }),
);

app.post('/api/auth/logout', (_req, res) => {
  res.clearCookie(COOKIE_NAME, { path: '/' });
  clearCsrfToken(res);
  res.json({ success: true });
});

/**
 * Session probe. Returns 200 with `user: null` when signed out — a 401 on first
 * paint is the normal anonymous path and filled the console with false alarms.
 * Also (re)issues the CSRF token so a client that has a valid session cookie
 * but lost its CSRF cookie can recover without signing in again.
 */
app.get(
  '/api/auth/me',
  wrap(async (req, res) => {
    const token = readToken(req);
    if (!token) return res.json({ user: null });

    try {
      const claims = jwt.verify(token, JWT_SECRET) as SessionClaims;
      const user = await store.users.findById(claims.id);
      if (!user) {
        res.clearCookie(COOKIE_NAME, { path: '/' });
        clearCsrfToken(res);
        return res.json({ user: null });
      }
      if (!req.cookies?.apex_csrf) issueCsrfToken(res, IS_PROD);
      return res.json({ user: publicUser(user) });
    } catch {
      res.clearCookie(COOKIE_NAME, { path: '/' });
      clearCsrfToken(res);
      return res.json({ user: null });
    }
  }),
);

// --------------------------------------------------------------------------
// MoL routing gate
// --------------------------------------------------------------------------
type Specialist = 'chat' | 'personal_agent' | 'genui' | 'coding';

const ROUTING_RULES: Array<{
  specialist: Specialist;
  weights: [number, number, number, number];
  terms: string[];
  explanation: string;
}> = [
  {
    specialist: 'genui',
    weights: [0.1, 0.1, 0.7, 0.1],
    terms: ['ui', 'widget', 'component', 'dashboard', 'genui', 'render', 'chart', 'gauge', 'visualise', 'visualize'],
    explanation: 'Routing gate selected the GenUI adapter for dynamic interface synthesis.',
  },
  {
    specialist: 'coding',
    weights: [0.1, 0.1, 0.15, 0.65],
    terms: ['code', 'script', 'python', 'function', 'fix', 'algorithm', 'refactor', 'bug', 'typescript'],
    explanation: 'Routing gate dispatched to the Coding adapter.',
  },
  {
    specialist: 'personal_agent',
    weights: [0.15, 0.65, 0.1, 0.1],
    terms: ['trade', 'profit', 'arbitrage', 'asset', 'task', 'workflow', 'schedule', 'inventory', 'stop loss'],
    explanation: 'Routing gate handed off to the Personal Agent for workflow orchestration and zero-loss checks.',
  },
];

function routeQuery(query: string) {
  const text = query.toLowerCase();
  let best = {
    specialist: 'chat' as Specialist,
    weights: [0.6, 0.2, 0.1, 0.1] as number[],
    explanation: 'Routing gate assigned the conversation to the Chat specialist.',
    score: 0,
  };

  for (const rule of ROUTING_RULES) {
    const score = rule.terms.reduce((acc, term) => (text.includes(term) ? acc + 1 : acc), 0);
    if (score > best.score) {
      best = {
        specialist: rule.specialist,
        weights: rule.weights,
        explanation: rule.explanation,
        score,
      };
    }
  }
  return best;
}

app.post('/api/mol-router', (req, res) => {
  const query = typeof req.body?.query === 'string' ? req.body.query.slice(0, 4000) : '';
  const routed = routeQuery(query);
  const [chat, personal_agent, genui, coding] = routed.weights;

  res.json({
    query,
    selectedSpecialist: routed.specialist,
    routingWeights: routed.weights,
    allocationTrace: { chat, personal_agent, genui, coding },
    latencyMs: Math.floor(12 + Math.random() * 15),
    explanation: routed.explanation,
    matchedTerms: routed.score,
    simulated: true,
  });
});

// --------------------------------------------------------------------------
// Model endpoints
// --------------------------------------------------------------------------
const GENUI_SYSTEM_PROMPT = `You are the GenUI specialist for V12 Apex Atlas.
Return ONLY the body of a React function component — a bare \`return ( ... )\` JSX statement.
Rules:
- No markdown fences, no imports, no export statements, no component declaration.
- Style exclusively with Tailwind utility classes.
- Read incoming values from the \`data\` object (it may be undefined; guard with \`data?.\`).
- Do not use browser storage, network calls, timers, or \`window\`.
Example:
return (
  <div className="p-4 bg-zinc-900 border border-emerald-500/30 rounded-xl text-zinc-100">
    <h3 className="text-emerald-400 font-bold text-sm mb-2">{data?.title || "Custom Component"}</h3>
    <p className="text-xs text-zinc-400">Generated component</p>
  </div>
);`;

function fallbackArtifact(prompt: string) {
  const safe = String(prompt || '').replace(/[<>{}`]/g, '').slice(0, 120);
  return `return (
  <div className="p-4 bg-zinc-900/90 border border-amber-500/40 rounded-xl text-zinc-100 shadow-xl font-mono">
    <div className="flex items-center space-x-2 mb-3">
      <div className="w-2.5 h-2.5 rounded-full bg-amber-400" />
      <span className="text-xs font-bold text-amber-400 uppercase tracking-wide">Offline template</span>
    </div>
    <p className="text-xs text-zinc-400 font-sans mb-3">
      The model was unavailable, so this placeholder was rendered locally. Request: "${safe}"
    </p>
    <div className="grid grid-cols-3 gap-2 text-center text-[11px]">
      <div className="bg-zinc-950 p-2 rounded border border-zinc-800">
        <div className="text-zinc-500">FPS</div>
        <div className="font-bold text-emerald-400">{data?.metrics?.fps ?? "—"}</div>
      </div>
      <div className="bg-zinc-950 p-2 rounded border border-zinc-800">
        <div className="text-zinc-500">LATENCY</div>
        <div className="font-bold text-cyan-400">{data?.metrics?.latencyMs ?? "—"} ms</div>
      </div>
      <div className="bg-zinc-950 p-2 rounded border border-zinc-800">
        <div className="text-zinc-500">LOAD</div>
        <div className="font-bold text-purple-400">{data?.metrics?.loadPct ?? "—"}%</div>
      </div>
    </div>
  </div>
);`;
}

app.post(
  '/api/gemini/genui',
  authenticate,
  aiLimiter,
  wrap(async (req, res) => {
    const prompt = typeof req.body?.prompt === 'string' ? req.body.prompt.slice(0, 2000) : '';
    const propsData = {
      title: prompt || 'Generated UI artifact',
      timestamp: new Date().toISOString(),
      metrics: { fps: 24000, loadPct: 42, latencyMs: 45 },
    };

    if (!hasApiKey()) {
      return res.json({
        code: fallbackArtifact(prompt),
        propsData,
        source: 'fallback',
        reason: 'GEMINI_API_KEY is not configured.',
      });
    }

    try {
      const response = await getGenAI().models.generateContent({
        model: GEMINI_MODEL,
        contents: prompt || 'Create a real-time GPU compute throughput gauge widget.',
        config: { systemInstruction: GENUI_SYSTEM_PROMPT, temperature: 0.7 },
      });

      const code = (response.text || '')
        .replace(/```(?:tsx|jsx|javascript|js)?/g, '')
        .replace(/```/g, '')
        .trim();

      if (!code) throw new Error('Model returned an empty component.');
      res.json({ code, propsData, source: 'model', model: GEMINI_MODEL });
    } catch (err) {
      console.error('[genui] generation failed:', err instanceof Error ? err.message : err);
      res.json({
        code: fallbackArtifact(prompt),
        propsData,
        source: 'fallback',
        reason: err instanceof Error ? err.message : 'Model request failed.',
      });
    }
  }),
);

const CHAT_SYSTEM_PROMPT = `You are the V12 Apex Atlas operations assistant.
You help operators manage digital-twin nodes, inspect routing decisions, review Hermes arbitrage evaluations, and use the UI4A REPL.
Be concise and concrete. When you reference figures from the workspace, say plainly that the current dataset is simulated. Never claim a trade has been executed — only the Hermes execution endpoint can do that.`;

app.post(
  '/api/gemini/chat',
  authenticate,
  aiLimiter,
  wrap(async (req, res) => {
    const message = typeof req.body?.message === 'string' ? req.body.message.slice(0, 8000) : '';
    const rawHistory = Array.isArray(req.body?.history) ? req.body.history : [];

    if (!message.trim()) return res.status(400).json({ error: 'A message is required.' });

    if (!hasApiKey()) {
      return res.json({
        reply:
          'The workspace is running without a model API key, so this is a local stub reply. ' +
          'Set GEMINI_API_KEY to enable live responses. Deterministic modules — routing, Hermes evaluation, the vault and the synchronizer — all work without it.',
        source: 'fallback',
      });
    }

    try {
      const contents = [
        ...rawHistory
          .filter((m: any) => m && typeof m.text === 'string' && (m.sender === 'user' || m.sender === 'agent'))
          .slice(-12)
          .map((m: any) => ({
            role: m.sender === 'user' ? 'user' : 'model',
            parts: [{ text: String(m.text).slice(0, 4000) }],
          })),
        { role: 'user', parts: [{ text: message }] },
      ];

      const response = await getGenAI().models.generateContent({
        model: GEMINI_MODEL,
        contents,
        config: { systemInstruction: CHAT_SYSTEM_PROMPT },
      });

      res.json({ reply: response.text || '(empty response)', source: 'model', model: GEMINI_MODEL });
    } catch (err) {
      console.error('[chat] generation failed:', err instanceof Error ? err.message : err);
      res.status(502).json({ error: 'The model backend is unavailable. Please retry.' });
    }
  }),
);

// --------------------------------------------------------------------------
// Hermes
// --------------------------------------------------------------------------
app.get(
  '/api/hermes/assets',
  optionalAuth,
  wrap(async (req, res) => {
    res.json({
      assets: await store.assets.list(publicTenant(req)),
      simulated: true,
      disclaimer: 'Prices are generated by the built-in simulator. Do not treat them as market data.',
    });
  }),
);

app.post(
  '/api/hermes/evaluate',
  optionalAuth,
  wrap(async (req, res) => {
    const { asset_id, stop_loss_pct, profit_target_pct } = req.body ?? {};
    const asset = await store.assets.get(publicTenant(req), asset_id);
    if (!asset) return res.status(404).json({ error: 'Asset not found.' });

    const policy: Record<string, number> = {};
    if (typeof stop_loss_pct === 'number' && stop_loss_pct > 0 && stop_loss_pct < 1) {
      policy.stop_loss_pct = stop_loss_pct;
    }
    if (typeof profit_target_pct === 'number' && profit_target_pct > 0 && profit_target_pct < 10) {
      policy.profit_target_pct = profit_target_pct;
    }

    res.json({ evaluation: evaluateAsset(asset, policy), simulated: true });
  }),
);

app.post(
  '/api/hermes/trade',
  authenticate,
  writeLimiter,
  requireRole('Executive', 'Arbitrage Trader', 'System Admin'),
  wrap(async (req, res) => {
    const { asset_id } = req.body ?? {};
    const actor = req.user!;
    const tenant = tenantOf(req);
    const asset = await store.assets.get(tenant, asset_id);

    if (!asset) return res.status(404).json({ error: 'Asset not found.' });

    // The decision is made here, from server-held state.
    const { allowed, evaluation, reason } = authoriseSell(asset);

    if (!allowed) {
      await store.audit.append(tenant, {
        event: 'trade.refused',
        actorId: actor.id,
        actorName: actor.name,
        actorRole: actor.role,
        subject: asset.asset_id,
        outcome: 'refused',
        detail: { reason, evaluation },
      });
      return res.status(409).json({ error: reason, evaluation });
    }

    // Compare-and-swap. If another request liquidated this position between the
    // read above and here, we get null and refuse rather than double-selling.
    const liquidation = await store.assets.liquidate(tenant, asset.asset_id);
    if (!liquidation) {
      await store.audit.append(tenant, {
        event: 'trade.refused',
        actorId: actor.id,
        actorName: actor.name,
        actorRole: actor.role,
        subject: asset.asset_id,
        outcome: 'refused',
        detail: { reason: 'Position was liquidated by a concurrent request.' },
      });
      return res.status(409).json({ error: 'Position was liquidated by a concurrent request.' });
    }

    const netPerUnit = evaluation.realized_net_per_unit ?? 0;
    const netTotal = Math.round(netPerUnit * liquidation.quantity * 100) / 100;

    const trade = {
      id: `trd-${crypto.randomUUID()}`,
      asset_id: asset.asset_id,
      action: evaluation.action,
      quantity: liquidation.quantity,
      unit_price: liquidation.unitPrice,
      realized_net_per_unit: netPerUnit,
      realized_net_total: netTotal,
      executedBy: actor.name,
      executedById: actor.id,
      timestamp: new Date().toISOString(),
      simulated: true,
    };

    await store.trades.record(tenant, trade);
    await store.audit.append(tenant, {
      event: 'trade.executed',
      actorId: actor.id,
      actorName: actor.name,
      actorRole: actor.role,
      subject: asset.asset_id,
      outcome: 'allowed',
      detail: { trade, evaluation },
    });

    if (asset.asset_class === 'H266_Video_NFT') {
      const warehouse = await store.nodes.get(tenant, 'node-warehouse-alpha');
      if (warehouse) {
        await store.nodes.update(
          tenant,
          'node-warehouse-alpha',
          {
            metrics: { allocated_inventory: 0 },
            content: `${warehouse.content}\n\n[${trade.timestamp}] ${evaluation.action} ${trade.quantity} units @ $${trade.unit_price.toFixed(2)} — net $${netTotal.toFixed(2)} (simulated)`,
          },
          actor.name,
        );
      }
    }

    res.json({ success: true, tradeLog: trade, evaluation, asset: liquidation.asset });
  }),
);

app.get(
  '/api/hermes/trades',
  authenticate,
  wrap(async (req, res) => {
    res.json({ trades: await store.trades.list(tenantOf(req), 100) });
  }),
);

// --------------------------------------------------------------------------
// Audit log
// --------------------------------------------------------------------------
app.get(
  '/api/audit',
  authenticate,
  requireRole('Executive', 'System Admin'),
  wrap(async (req, res) => {
    const limit = Math.min(Number(req.query.limit) || 100, 500);
    const tenant = tenantOf(req);
    const [entries, chain] = await Promise.all([store.audit.list(tenant, limit), store.audit.verify(tenant)]);
    res.json({ entries, chain });
  }),
);

app.get(
  '/api/audit/verify',
  authenticate,
  requireRole('Executive', 'System Admin'),
  wrap(async (req, res) => {
    res.json({ chain: await store.audit.verify(tenantOf(req)) });
  }),
);

// --------------------------------------------------------------------------
// Execution desk — orders, fills, positions, risk
// --------------------------------------------------------------------------
const TRADE_ROLES: UserRole[] = ['Executive', 'Arbitrage Trader', 'System Admin'];

/** Snapshot of everything the desk needs, in one round trip. */
app.get(
  '/api/execution/state',
  optionalAuth,
  wrap(async (req, res) => {
    const tenant = publicTenant(req);
    const trading = await runtimeFor(tenant);
    const assetSpecs = [...trading.assetSpecs.values()];

    const rows = await Promise.all(
      assetSpecs.map(async (instrument) => {
        const [quote, position] = await Promise.all([
          trading.execution.quote(instrument.assetId),
          trading.execution.position(instrument.assetId),
        ]);
        return {
          spec: instrument,
          quote,
          position,
          unrealisedPnl: quote ? unrealisedPnl(position, quote.bid || quote.last) : 0,
          plan: planFor(instrument, position, quote),
        };
      }),
    );

    const [orders, fills, dailyNotional, tenantRecord] = await Promise.all([
      store.orders.list(tenant, 50),
      store.fills.list(tenant, 50),
      trading.execution.dailyNotional(),
      store.tenants.get(tenant),
    ]);

    res.json({
      tenant: tenantRecord
        ? { id: tenantRecord.id, name: tenantRecord.name, plan: tenantRecord.plan, tradingEnabled: tenantRecord.tradingEnabled }
        : null,
      mode: 'internal',
      marketplace: trading.marketplace.id,
      bidFeed: trading.bids.id,
      simulated: true,
      risk: { ...trading.risk.current, dailyNotionalUsed: round(dailyNotional, 2) },
      lastReconciliation: trading.lastReconciliation,
      rows,
      orders,
      fills,
    });
  }),
);

/** Place an order. Risk-checked server-side, audited either way. */
app.post(
  '/api/execution/order',
  authenticate,
  writeLimiter,
  requireRole(...TRADE_ROLES),
  wrap(async (req, res) => {
    const actor = req.user!;
    const tenant = tenantOf(req);
    const trading = await runtimeFor(tenant);

    // Trading is a plan entitlement, checked before anything else touches a venue.
    const tenantRecord = await store.tenants.get(tenant);
    if (!tenantRecord?.tradingEnabled) {
      return res.status(402).json({
        error: `The ${tenantRecord?.plan ?? 'current'} plan does not include trade execution.`,
        code: 'trading_not_entitled',
      });
    }

    const { assetId, side, quantity, type, limitPrice, timeInForce, reason } = req.body ?? {};
    const instrument = trading.assetSpecs.get(assetId);
    if (!instrument) return res.status(404).json({ error: 'Unknown asset.' });
    if (side !== 'buy' && side !== 'sell') return res.status(400).json({ error: 'Side must be buy or sell.' });
    if (typeof quantity !== 'number' || !Number.isFinite(quantity)) {
      return res.status(400).json({ error: 'Quantity must be a number.' });
    }

    const orderType = type === 'market' ? 'market' : 'limit';
    const intent = {
      clientOrderId: ExecutionService.newClientOrderId(),
      assetId,
      side,
      quantity,
      type: orderType as 'market' | 'limit',
      limitPrice: orderType === 'limit' ? Number(limitPrice) : undefined,
      timeInForce: (['gtc', 'ioc', 'fok'].includes(timeInForce) ? timeInForce : 'gtc') as 'gtc' | 'ioc' | 'fok',
      reason: typeof reason === 'string' ? reason.slice(0, 200) : 'manual',
    };

    const [quote, position, dailyNotionalUsed, vaultNodes] = await Promise.all([
      trading.execution.quote(assetId),
      trading.execution.position(assetId),
      trading.execution.dailyNotional(),
      store.nodes.list(tenant),
    ]);

    /*
     * The fundamental invalidation breaker reads the vault at decision time,
     * not at boot.
     *
     * `assetSpecs` is built once when the runtime starts. If an operator marks
     * a render line degraded in Obsidian at 09:00, a breaker that consulted the
     * boot-time snapshot would keep authorising acquisitions until the next
     * restart — which is exactly the window the breaker exists to close. The
     * vault is small and the parse is microseconds; correctness wins.
     *
     * The two conditions are ANDed, not replaced: an asset flagged invalid in
     * the asset table stays invalid regardless of what the twin says.
     */
    const graph = buildGraph(vaultNodes);
    const spec = {
      ...instrument,
      fundamentals_intact:
        instrument.fundamentals_intact && fundamentalsIntact(graph, instrument.asset_class),
    };

    const verdict = trading.risk.assess(intent, {
      spec,
      quote,
      position,
      dailyNotionalUsed,
      referencePrice: quote?.last ?? null,
      mode: 'internal',
      now: Date.now(),
    });

    if (!verdict.allowed) {
      await store.audit.append(tenant, {
        event: 'order.refused',
        actorId: actor.id,
        actorName: actor.name,
        actorRole: actor.role,
        subject: assetId,
        outcome: 'refused',
        detail: { intent, violations: verdict.violations, notional: verdict.notional },
      });
      return res.status(409).json({
        error: verdict.violations[0]?.message ?? 'Order refused by risk controls.',
        violations: verdict.violations,
      });
    }

    try {
      const result = await trading.execution.place(intent, { id: actor.id, name: actor.name });

      await store.audit.append(tenant, {
        event: result.order.status === 'rejected' ? 'order.rejected' : 'order.placed',
        actorId: actor.id,
        actorName: actor.name,
        actorRole: actor.role,
        subject: assetId,
        outcome: result.order.status === 'rejected' ? 'refused' : 'allowed',
        detail: {
          clientOrderId: intent.clientOrderId,
          side,
          quantity,
          type: orderType,
          limitPrice: intent.limitPrice ?? null,
          notional: verdict.notional,
          status: result.order.status,
          deduplicated: result.deduplicated,
          resolvedAfterFailure: result.resolvedAfterFailure ?? null,
        },
      });

      res.status(201).json({ order: result.order, resolvedAfterFailure: result.resolvedAfterFailure ?? null });
    } catch (err) {
      // Unknown state: the order is left pending for reconciliation. This is
      // recorded as a refusal so it surfaces in the audit log for review.
      const message = err instanceof Error ? err.message : 'Venue unreachable.';
      await store.audit.append(tenant, {
        event: 'order.unknown_state',
        actorId: actor.id,
        actorName: actor.name,
        actorRole: actor.role,
        subject: assetId,
        outcome: 'refused',
        detail: { clientOrderId: intent.clientOrderId, message },
      });
      res.status(502).json({ error: message, clientOrderId: intent.clientOrderId });
    }
  }),
);

app.post(
  '/api/execution/order/:clientOrderId/cancel',
  authenticate,
  writeLimiter,
  requireRole(...TRADE_ROLES),
  wrap(async (req, res) => {
    const tenant = tenantOf(req);
    const trading = await runtimeFor(tenant);
    const order = await trading.execution.cancel(req.params.clientOrderId);
    if (!order) return res.status(404).json({ error: 'Order not found.' });

    await store.audit.append(tenant, {
      event: 'order.cancelled',
      actorId: req.user!.id,
      actorName: req.user!.name,
      actorRole: req.user!.role,
      subject: order.assetId,
      outcome: order.status === 'cancelled' ? 'allowed' : 'refused',
      detail: { clientOrderId: order.clientOrderId, status: order.status },
    });

    res.json({ order });
  }),
);

/** Kill switch. Halting is always permitted; resuming needs a senior role. */
app.post(
  '/api/execution/halt',
  authenticate,
  requireRole(...TRADE_ROLES),
  wrap(async (req, res) => {
    const tenant = tenantOf(req);
    const trading = await runtimeFor(tenant);
    const reason = typeof req.body?.reason === 'string' ? req.body.reason.slice(0, 300) : 'Halted by operator.';
    const limits = trading.risk.halt(reason);

    await store.audit.append(tenant, {
      event: 'risk.halted',
      actorId: req.user!.id,
      actorName: req.user!.name,
      actorRole: req.user!.role,
      subject: 'execution',
      outcome: 'allowed',
      detail: { reason },
    });

    res.json({ risk: limits });
  }),
);

app.post(
  '/api/execution/resume',
  authenticate,
  requireRole('Executive', 'System Admin'),
  wrap(async (req, res) => {
    const tenant = tenantOf(req);
    const trading = await runtimeFor(tenant);
    const limits = trading.risk.resume();
    await store.audit.append(tenant, {
      event: 'risk.resumed',
      actorId: req.user!.id,
      actorName: req.user!.name,
      actorRole: req.user!.role,
      subject: 'execution',
      outcome: 'allowed',
      detail: {},
    });
    res.json({ risk: limits });
  }),
);

app.post(
  '/api/execution/reconcile',
  authenticate,
  requireRole('Executive', 'System Admin'),
  wrap(async (req, res) => {
    const tenant = tenantOf(req);
    const trading = await runtimeFor(tenant);
    const report = await trading.execution.reconcile();
    trading.lastReconciliation = report;

    await store.audit.append(tenant, {
      event: 'execution.reconciled',
      actorId: req.user!.id,
      actorName: req.user!.name,
      actorRole: req.user!.role,
      subject: trading.marketplace.id,
      outcome: report.discrepancies.length > 0 ? 'refused' : 'info',
      detail: { ...report },
    });

    res.json({ report });
  }),
);

// --------------------------------------------------------------------------
// Digital twin vault
// --------------------------------------------------------------------------
app.get(
  '/api/vault/nodes',
  optionalAuth,
  wrap(async (req, res) => {
    res.json({ nodes: await store.nodes.list(publicTenant(req)) });
  }),
);

app.put(
  '/api/vault/node',
  authenticate,
  writeLimiter,
  requireRole('Executive', 'System Admin', 'LoRABlender Engineer'),
  wrap(async (req, res) => {
    const { id, content, metrics } = req.body ?? {};

    if (content !== undefined && (typeof content !== 'string' || content.length > 100_000)) {
      return res.status(400).json({ error: 'Node content must be a string under 100,000 characters.' });
    }
    if (metrics !== undefined && (typeof metrics !== 'object' || metrics === null || Array.isArray(metrics))) {
      return res.status(400).json({ error: 'Metrics must be an object.' });
    }

    const node = await store.nodes.update(tenantOf(req), id, { content, metrics }, req.user!.name);
    if (!node) return res.status(404).json({ error: 'Node not found.' });

    await store.audit.append(tenantOf(req), {
      event: 'vault.updated',
      actorId: req.user!.id,
      actorName: req.user!.name,
      actorRole: req.user!.role,
      subject: node.filePath,
      outcome: 'allowed',
      detail: { bytes: node.content.length },
    });

    res.json({ success: true, node });
  }),
);

/**
 * The twin as a computed graph.
 *
 * Everything here is derived from the vault on every request. That is a
 * deliberate choice over caching: the graph is small, the parse is
 * microseconds, and a cached twin that disagrees with the markdown a user just
 * edited is worse than no twin at all. If this ever gets slow, the fix is a
 * cache keyed on the vault's last-updated timestamp — not a second copy of the
 * data in its own tables.
 */
app.get(
  '/api/twin/graph',
  optionalAuth,
  wrap(async (req, res) => {
    const tenant = publicTenant(req);
    const [nodes, assets] = await Promise.all([store.nodes.list(tenant), store.assets.list(tenant)]);

    const graph = buildGraph(nodes);

    // Fee rates come from the asset table rather than the vault: they are a
    // property of the counterparty, not of the warehouse holding the goods.
    const fees: FeeTable = {};
    for (const asset of assets) {
      fees[asset.asset_class] = { buy: asset.buy_fees, sell: asset.sell_fees };
    }

    const valuation = valueEcosystem(graph, fees);

    res.json({
      hubs: [...graph.hubs.values()],
      factories: [...graph.factories.values()],
      warehouses: [...graph.warehouses.values()],
      issues: graph.issues,
      valuation,
      mandate: SPEC_MANDATE,
      derivedAt: new Date().toISOString(),
    });
  }),
);

// --------------------------------------------------------------------------
// Synchronizer telemetry
// --------------------------------------------------------------------------
app.get(
  '/api/sync/telemetry',
  optionalAuth,
  wrap(async (req, res) => {
    const spike = Math.random() < 0.04;
    const latency = spike ? Math.floor(210 + Math.random() * 180) : Math.floor(42 + Math.random() * 6);
    const h266 = await store.assets.get(publicTenant(req), 'AST-H266-001');

    res.json({
      timestamp: new Date().toISOString(),
      latencyMs: latency,
      targetNode: '30_Logistics_Nodes/Warehouse-Midwest-Alpha.md',
      status: latency > 200 ? 'REPLICATING' : 'SYNCED',
      bidFloor: h266?.active_offer ?? h266?.current_price ?? 16.8,
      sha3Hash: `SHA3-${crypto.randomBytes(4).toString('hex').toUpperCase()}`,
      activeThroughputFps: 24000,
      activeHz: 192000,
      simulated: true,
    });
  }),
);

// --------------------------------------------------------------------------
// Static hosting / dev middleware
// --------------------------------------------------------------------------
app.use('/api', (_req, res) => res.status(404).json({ error: 'Unknown API route.' }));

// eslint-disable-next-line @typescript-eslint/no-unused-vars
app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
  console.error('[error]', err);
  if (err?.type === 'entity.too.large') return res.status(413).json({ error: 'Request body too large.' });
  res.status(500).json({ error: 'Internal server error.' });
});

async function startServer() {
  const initialised = await initialiseStore(await createStore());
  store = initialised.store;
  defaultTenant = initialised.defaultTenant;
  console.log(
    `[V12 Apex Atlas] storage backend: ${store.dialect} · tenancy: ${MULTI_TENANT ? 'multi' : 'single'}` +
      ` · default tenant: ${defaultTenant.slug} (${defaultTenant.plan})`,
  );

  const chain = await store.audit.verifyAll();
  if (!chain.ok) {
    console.error(`[V12 Apex Atlas] AUDIT CHAIN BROKEN for tenant(s): ${chain.broken.join(', ')}`);
  }

  // Warm the default tenant so a single-tenant deployment reconciles at boot
  // rather than on first request. Other tenants spin up lazily.
  const boot = await runtimeFor(defaultTenant.id);
  console.log(
    `[V12 Apex Atlas] execution: venue=${boot.marketplace.id} mode=${'internal'}` +
      `${boot.risk.isHalted ? ' (HALTED)' : ''}`,
  );

  if (!IS_PROD) {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({ server: { middlewareMode: true }, appType: 'spa' });
    app.use(vite.middlewares);
  } else {
    const clientDir = path.join(process.cwd(), 'dist', 'client');
    app.use(express.static(clientDir, { maxAge: '1h', index: false }));
    app.get('*', (_req, res) => res.sendFile(path.join(clientDir, 'index.html')));
  }

  const server = app.listen(PORT, '0.0.0.0', () => {
    console.log(`[V12 Apex Atlas] listening on http://0.0.0.0:${PORT} (${IS_PROD ? 'production' : 'development'})`);
    if (!hasApiKey()) console.log('[V12 Apex Atlas] GEMINI_API_KEY not set — model features run in fallback mode.');
  });

  const shutdown = async (signal: string) => {
    console.log(`[V12 Apex Atlas] ${signal} received, shutting down.`);
    server.close();
    await Promise.all([...runtimes.values()].map((r) => r.stop().catch(() => undefined)));
    await store.close().catch(() => undefined);
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

startServer().catch((err) => {
  console.error('[fatal] Server failed to start:', err);
  process.exit(1);
});
