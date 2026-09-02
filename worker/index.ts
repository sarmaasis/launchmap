import { Hono } from "hono";
import { cors } from "hono/cors";
import {
  canCreateLaunch,
  consumeMagicLink,
  createMagicLink,
  createSession,
  destroySession,
  findOrCreateUser,
  getSessionUser,
  showWatermark,
  type UserRow,
} from "./lib/auth";
import { randomId, sha256Hex } from "./lib/crypto";
import { createDodoCheckoutSession, customerEmailFromDodoPayload, monthlyProductId } from "./lib/dodo";
import { sendMagicLinkEmail } from "./lib/email";
import { geoFromCountry, jitter } from "./lib/geo";
import { verifyStandardWebhook } from "./lib/standard-webhooks";

type App = { Bindings: Env };
const app = new Hono<App>();

const COLLECT_WINDOW_MS = 60_000;
const COLLECT_LIMIT = 40;

app.get("/api/health", (c) => c.json({ ok: true, name: c.env.APP_NAME ?? "Launchmap" }));

app.get("/api/demo", (c) => c.json(demoBoard()));

app.get("/api/me", async (c) => {
  const user = await getSessionUser(c);
  if (!user) return c.json({ user: null }, 401);
  const count = await countLaunches(c.env.DB, user.id);
  return c.json({ user: publicUser(user, count) });
});

app.post("/api/auth/login", async (c) => {
  const body = await c.req.json().catch(() => ({})) as { email?: string };
  const email = (body.email ?? "").trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return c.json({ error: "Enter a valid email." }, 400);
  const user = await findOrCreateUser(c.env.DB, email);
  const token = await createMagicLink(c.env.DB, c.env.SESSION_SECRET, user.id);
  const verifyUrl = `${appOrigin(c)}/auth/verify?token=${encodeURIComponent(token)}`;
  const result = await sendMagicLinkEmail(c.env, email, verifyUrl);
  return c.json({
    ok: true,
    emailed: result.delivered,
    verifyUrl: result.delivered ? undefined : verifyUrl,
    message: result.delivered
      ? "Check your inbox. The link expires in 15 minutes."
      : "Email is not configured. Use the logged URL (returned here in development).",
  });
});

app.get("/auth/verify", async (c) => {
  const token = c.req.query("token");
  if (!token) return c.redirect("/login?error=missing_token");
  const user = await consumeMagicLink(c.env.DB, c.env.SESSION_SECRET, token);
  if (!user) return c.redirect("/login?error=invalid_or_expired");
  await createSession(c, user.id);
  return c.redirect("/app");
});

app.post("/api/auth/logout", async (c) => {
  await destroySession(c);
  return c.json({ ok: true });
});

app.get("/api/launches", async (c) => {
  const user = await getSessionUser(c);
  if (!user) return c.json({ error: "Unauthorized" }, 401);
  const { results } = await c.env.DB.prepare(
    "SELECT id, name, slug, site_url, manual_revenue_cents, created_at FROM launches WHERE user_id = ? ORDER BY created_at DESC",
  ).bind(user.id).all<LaunchRow>();
  const origin = appOrigin(c);
  const watermark = showWatermark(user);
  const launches = (results ?? []).map((row) => ({ ...row, public_url: `${origin}/l/${row.slug}`, watermark }));
  return c.json({ launches, entitlement: publicUser(user, launches.length) });
});

app.post("/api/launches", async (c) => {
  const user = await getSessionUser(c);
  if (!user) return c.json({ error: "Unauthorized" }, 401);
  const body = await c.req.json().catch(() => ({})) as { name?: string; slug?: string; site_url?: string };
  const name = (body.name ?? "").trim();
  const slug = slugify(body.slug?.trim() || name);
  const site_url = (body.site_url ?? "").trim();
  if (!name || !slug) return c.json({ error: "Name and slug are required." }, 400);
  const existing = await countLaunches(c.env.DB, user.id);
  if (!canCreateLaunch(user, existing)) {
    return c.json({ error: "Free accounts get one launch. Unlock more with $19 or $9/mo." }, 402);
  }
  const row = { id: randomId(), name, slug, site_url, created_at: Date.now() };
  try {
    await c.env.DB.prepare(
      "INSERT INTO launches (id, user_id, name, slug, site_url, manual_revenue_cents, created_at) VALUES (?, ?, ?, ?, ?, 0, ?)",
    ).bind(row.id, user.id, row.name, row.slug, row.site_url, row.created_at).run();
  } catch {
    return c.json({ error: "That slug is taken." }, 409);
  }
  return c.json({ launch: { ...row, manual_revenue_cents: 0, public_url: `${appOrigin(c)}/l/${slug}` } }, 201);
});

app.patch("/api/launches/:id", async (c) => {
  const user = await getSessionUser(c);
  if (!user) return c.json({ error: "Unauthorized" }, 401);
  const body = await c.req.json().catch(() => ({})) as { name?: string; site_url?: string; manual_revenue_cents?: number };
  const launch = await c.env.DB.prepare("SELECT id FROM launches WHERE id = ? AND user_id = ?").bind(c.req.param("id"), user.id).first();
  if (!launch) return c.json({ error: "Not found" }, 404);
  if (typeof body.name === "string" && body.name.trim()) {
    await c.env.DB.prepare("UPDATE launches SET name = ? WHERE id = ? AND user_id = ?").bind(body.name.trim(), c.req.param("id"), user.id).run();
  }
  if (typeof body.site_url === "string") {
    await c.env.DB.prepare("UPDATE launches SET site_url = ? WHERE id = ? AND user_id = ?").bind(body.site_url.trim(), c.req.param("id"), user.id).run();
  }
  if (typeof body.manual_revenue_cents === "number" && Number.isFinite(body.manual_revenue_cents)) {
    const cents = Math.max(0, Math.round(body.manual_revenue_cents));
    await c.env.DB.prepare("UPDATE launches SET manual_revenue_cents = ? WHERE id = ? AND user_id = ?").bind(cents, c.req.param("id"), user.id).run();
  }
  return c.json({ ok: true });
});

app.get("/api/public/:slug", async (c) => {
  const slug = c.req.param("slug");
  const launch = await c.env.DB.prepare(
    "SELECT launches.id, launches.name, launches.slug, launches.site_url, launches.manual_revenue_cents, launches.created_at, users.plan, users.watermark FROM launches JOIN users ON users.id = launches.user_id WHERE launches.slug = ?",
  ).bind(slug).first<LaunchRow & { plan: string; watermark: number }>();
  if (!launch) return c.json({ error: "Not found" }, 404);
  const board = await loadBoard(c.env.DB, launch);
  return c.json({ ...board, watermark: showWatermark(launch) });
});

app.use("/t/:slug/collect", cors({ origin: "*", allowMethods: ["POST", "OPTIONS"], allowHeaders: ["Content-Type"] }));

app.post("/t/:slug/collect", async (c) => {
  const slug = c.req.param("slug");
  const ip = c.req.header("cf-connecting-ip") || c.req.header("x-forwarded-for") || "0.0.0.0";
  const limited = await rateLimited(c.env.DB, `collect:${slug}:${ip}`, COLLECT_LIMIT, COLLECT_WINDOW_MS);
  if (limited) return c.json({ error: "rate_limited" }, 429);
  const launch = await c.env.DB.prepare("SELECT id FROM launches WHERE slug = ?").bind(slug).first<{ id: string }>();
  if (!launch) return c.json({ error: "not_found" }, 404);
  const body = await c.req.json().catch(() => ({})) as { t?: string; type?: string; p?: string; path?: string; amount_cents?: number };
  const kindRaw = (body.t || body.type || "pageview").toLowerCase();
  const kind = kindRaw === "signup" || kindRaw === "payment" ? kindRaw : "pageview";
  const ua = c.req.header("user-agent") ?? "";
  const visitor_hash = (await sha256Hex(`${ip}|${ua}`)).slice(0, 16);
  const geo = jitter(geoFromCountry(c.req.header("cf-ipcountry")), visitor_hash);
  const amount = kind === "payment" && typeof body.amount_cents === "number" ? Math.max(0, Math.round(body.amount_cents)) : 0;
  await c.env.DB.prepare(
    "INSERT INTO events (id, launch_id, kind, visitor_hash, country, city, lat, lng, path, amount_cents, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  ).bind(randomId(), launch.id, kind, visitor_hash, geo.country, geo.city, geo.lat, geo.lng, (body.p || body.path || "/").slice(0, 180), amount, Date.now()).run();
  return c.json({ ok: true });
});

app.get("/embed.js", (c) => {
  const origin = appOrigin(c);
  const js = `(function(){var s=document.currentScript;if(!s)return;var slug=s.getAttribute("data-slug");if(!slug)return;var o="${origin}";function ping(t,extra){try{fetch(o+"/t/"+encodeURIComponent(slug)+"/collect",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(Object.assign({t:t,p:location.pathname},extra||{})),mode:"cors",keepalive:true,credentials:"omit"});}catch(e){}}ping("pageview");window.launchmapSignup=function(){ping("signup")};})();`;
  return new Response(js, { headers: { "content-type": "application/javascript; charset=utf-8", "cache-control": "public, max-age=300", "access-control-allow-origin": "*" } });
});

app.post("/api/checkout", async (c) => {
  const user = await getSessionUser(c);
  if (!user) return c.json({ error: "Unauthorized" }, 401);
  if (!c.env.DODO_PAYMENTS_API_KEY) return c.json({ error: "Dodo Payments is not configured. Set DODO_PAYMENTS_API_KEY." }, 500);
  const body = await c.req.json().catch(() => ({})) as { plan?: string; launch_id?: string };
  const plan = body.plan === "monthly" ? "monthly" : "one_launch";
  const productId = plan === "monthly" ? monthlyProductId(c.env) : c.env.DODO_PRODUCT_ID;
  if (!productId) return c.json({ error: plan === "monthly" ? "Set DODO_MONTHLY_PRODUCT_ID or DODO_PRICE." : "Set DODO_PRODUCT_ID." }, 500);
  try {
    const session = await createDodoCheckoutSession({
      apiKey: c.env.DODO_PAYMENTS_API_KEY,
      environment: c.env.DODO_PAYMENTS_ENVIRONMENT,
      productId,
      email: user.email,
      returnUrl: `${appOrigin(c)}/checkout/success`,
      metadata: { source: "launchmap", email: user.email, user_id: user.id, plan, launch_id: body.launch_id ?? "" },
    });
    return c.json({ checkout_url: session.checkout_url, session_id: session.session_id });
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : "Checkout failed" }, 502);
  }
});

app.post("/webhooks/dodo", async (c) => {
  const rawBody = await c.req.text();
  const webhookId = c.req.header("webhook-id") ?? "";
  const webhookSignature = c.req.header("webhook-signature") ?? "";
  const webhookTimestamp = c.req.header("webhook-timestamp") ?? "";
  if (!c.env.DODO_PAYMENTS_WEBHOOK_KEY) return c.json({ error: "DODO_PAYMENTS_WEBHOOK_KEY is not configured" }, 500);
  try {
    await verifyStandardWebhook({ payload: rawBody, webhookId, webhookTimestamp, webhookSignature, secret: c.env.DODO_PAYMENTS_WEBHOOK_KEY });
  } catch (err) {
    console.error("Dodo webhook verification failed", err);
    return c.json({ error: "Invalid signature" }, 401);
  }
  const existing = await c.env.DB.prepare("SELECT webhook_id FROM webhook_events WHERE webhook_id = ?").bind(webhookId).first();
  if (existing) return c.json({ received: true, duplicate: true });
  let event: { type?: string; data?: Record<string, unknown> };
  try { event = JSON.parse(rawBody) as { type?: string; data?: Record<string, unknown> }; }
  catch { return c.json({ error: "Invalid JSON" }, 400); }
  await c.env.DB.prepare("INSERT INTO webhook_events (webhook_id, event_type, payload, processed_at) VALUES (?, ?, ?, ?)").bind(webhookId, event.type ?? "unknown", rawBody, Date.now()).run();
  if (event.type === "payment.succeeded") await onPaymentSucceeded(c.env.DB, event.data ?? {});
  if (event.type === "subscription.active") await onSubscriptionActive(c.env.DB, event.data ?? {});
  return c.json({ received: true });
});

async function onPaymentSucceeded(db: D1Database, data: Record<string, unknown>): Promise<void> {
  const email = customerEmailFromDodoPayload(data);
  const paymentId = typeof data.payment_id === "string" ? data.payment_id : null;
  const customer = data.customer as { customer_id?: string } | undefined;
  const metadata = (data.metadata ?? {}) as { user_id?: string; email?: string; plan?: string; launch_id?: string };
  const amount = typeof data.total_amount === "number" ? data.total_amount : typeof data.amount === "number" ? data.amount : 0;
  const now = Date.now();
  let userId = metadata.user_id;
  if (!userId) {
    const target = email ?? metadata.email?.toLowerCase();
    if (!target) return;
    const user = await findOrCreateUser(db, target);
    userId = user.id;
  }
  if (metadata.plan !== "monthly") {
    await db.prepare("UPDATE users SET launch_credits = launch_credits + 1, watermark = 0, dodo_customer_id = COALESCE(?, dodo_customer_id), dodo_payment_id = COALESCE(?, dodo_payment_id) WHERE id = ?").bind(customer?.customer_id ?? null, paymentId, userId).run();
  }
  if (metadata.launch_id && amount > 0) {
    await db.prepare("INSERT INTO events (id, launch_id, kind, visitor_hash, country, city, lat, lng, path, amount_cents, created_at) VALUES (?, ?, ?, NULL, NULL, NULL, NULL, NULL, ?, ?, ?)").bind(randomId(), metadata.launch_id, "payment", "dodo", amount, now).run();
  }
}

async function onSubscriptionActive(db: D1Database, data: Record<string, unknown>): Promise<void> {
  const email = customerEmailFromDodoPayload(data);
  const customer = data.customer as { customer_id?: string } | undefined;
  const metadata = (data.metadata ?? {}) as { user_id?: string; email?: string };
  const subId = typeof data.subscription_id === "string" ? data.subscription_id : null;
  let userId = metadata.user_id;
  if (!userId) {
    const target = email ?? metadata.email?.toLowerCase();
    if (!target) return;
    userId = (await findOrCreateUser(db, target)).id;
  }
  await db.prepare("UPDATE users SET plan = ?, plan_status = ?, watermark = 0, dodo_customer_id = COALESCE(?, dodo_customer_id), dodo_subscription_id = COALESCE(?, dodo_subscription_id) WHERE id = ?").bind("monthly", "active", customer?.customer_id ?? null, subId, userId).run();
}

type LaunchRow = { id: string; name: string; slug: string; site_url: string | null; manual_revenue_cents: number; created_at: number };

async function loadBoard(db: D1Database, launch: LaunchRow) {
  const views = await db.prepare("SELECT COUNT(*) as n FROM events WHERE launch_id = ? AND kind = ?").bind(launch.id, "pageview").first<{ n: number }>();
  const uniques = await db.prepare("SELECT COUNT(DISTINCT visitor_hash) as n FROM events WHERE launch_id = ? AND kind = ?").bind(launch.id, "pageview").first<{ n: number }>();
  const signups = await db.prepare("SELECT COUNT(*) as n FROM events WHERE launch_id = ? AND kind = ?").bind(launch.id, "signup").first<{ n: number }>();
  const paid = await db.prepare("SELECT COALESCE(SUM(amount_cents), 0) as n FROM events WHERE launch_id = ? AND kind = ?").bind(launch.id, "payment").first<{ n: number }>();
  const { results } = await db.prepare("SELECT id, kind, country, city, lat, lng, path, amount_cents, created_at FROM events WHERE launch_id = ? ORDER BY created_at DESC LIMIT 40").bind(launch.id).all<VisitorHit>();
  return {
    launch: { name: launch.name, slug: launch.slug, site_url: launch.site_url },
    stats: {
      views: views?.n ?? 0,
      unique: uniques?.n ?? 0,
      signups: signups?.n ?? 0,
      revenue_cents: (launch.manual_revenue_cents ?? 0) + (paid?.n ?? 0),
    },
    visitors: results ?? [],
  };
}

type VisitorHit = { id: string; kind: string; country: string | null; city: string | null; lat: number | null; lng: number | null; path: string | null; amount_cents: number; created_at: number };

function demoBoard() {
  const cities: { city: string; country: string; lat: number; lng: number }[] = [
    { city: "San Francisco", country: "US", lat: 37.7, lng: -122.4 },
    { city: "Bengaluru", country: "IN", lat: 12.9, lng: 77.6 },
    { city: "Berlin", country: "DE", lat: 52.5, lng: 13.4 },
    { city: "Tokyo", country: "JP", lat: 35.6, lng: 139.7 },
    { city: "Sao Paulo", country: "BR", lat: -23.5, lng: -46.6 },
    { city: "London", country: "GB", lat: 51.5, lng: -0.1 },
    { city: "Lagos", country: "NG", lat: 6.5, lng: 3.3 },
    { city: "Sydney", country: "AU", lat: -33.8, lng: 151.2 },
    { city: "Toronto", country: "CA", lat: 43.6, lng: -79.3 },
    { city: "Singapore", country: "SG", lat: 1.3, lng: 103.8 },
  ];
  const now = Date.now();
  const tick = Math.floor(now / 2800);
  const visitors = Array.from({ length: 14 }, (_, i) => {
    const city = cities[(tick + i * 3) % cities.length];
    const kind = i % 7 === 0 ? "signup" : i % 11 === 0 ? "payment" : "pageview";
    return { id: `demo-${tick}-${i}`, kind, country: city.country, city: city.city, lat: city.lat, lng: city.lng, path: i % 2 ? "/" : "/pricing", amount_cents: kind === "payment" ? 1900 : 0, created_at: now - i * 1700 };
  });
  return { launch: { name: "Acme launch week", slug: "demo", site_url: "https://example.com" }, stats: { views: 1280 + (tick % 40), unique: 412 + (tick % 12), signups: 86 + (tick % 5), revenue_cents: 1900 }, visitors, watermark: false, demo: true };
}

async function rateLimited(db: D1Database, key: string, limit: number, windowMs: number): Promise<boolean> {
  const now = Date.now();
  const windowStart = now - windowMs;
  const row = await db.prepare("SELECT count, window_start FROM rate_limits WHERE key = ?").bind(key).first<{ count: number; window_start: number }>();
  if (!row || row.window_start < windowStart) {
    await db.prepare("INSERT INTO rate_limits (key, count, window_start) VALUES (?, 1, ?) ON CONFLICT(key) DO UPDATE SET count = 1, window_start = ?").bind(key, now, now).run();
    return false;
  }
  if (row.count >= limit) return true;
  await db.prepare("UPDATE rate_limits SET count = count + 1 WHERE key = ?").bind(key).run();
  return false;
}

async function countLaunches(db: D1Database, userId: string): Promise<number> {
  const row = await db.prepare("SELECT COUNT(*) as n FROM launches WHERE user_id = ?").bind(userId).first<{ n: number }>();
  return row?.n ?? 0;
}

function publicUser(user: UserRow, launchCount: number) {
  return {
    id: user.id,
    email: user.email,
    plan: user.plan,
    plan_status: user.plan_status,
    launch_credits: user.launch_credits,
    watermark: showWatermark(user),
    launch_count: launchCount,
    can_create: canCreateLaunch(user, launchCount),
  };
}

function appOrigin(c: { env: Env; req: { url: string } }): string {
  if (c.env.APP_URL) return c.env.APP_URL.replace(/\/$/, "");
  return new URL(c.req.url).origin;
}

function slugify(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48);
}

export default app;
