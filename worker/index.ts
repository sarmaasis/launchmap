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
import { randomId } from "./lib/crypto";
import { createDodoCheckoutSession, customerEmailFromDodoPayload, productIdForPlan } from "./lib/dodo";
import { sendMagicLinkEmail } from "./lib/email";
import { geoFromCountry, jitter } from "./lib/geo";
import { verifyStandardWebhook } from "./lib/standard-webhooks";
import { isBot } from "./lib/bots";
import { dayVisitorHash, retentionMs } from "./lib/hashday";
import { eraseUser, exportAccount, purgeExpiredEvents } from "./lib/purge";
import { securityHeaders } from "./lib/security";
import { finishOAuth, oauthConfigured, startOAuth } from "./lib/oauth";

type App = { Bindings: Env };
const app = new Hono<App>();
app.use("*", securityHeaders);

const COLLECT_WINDOW_MS = 60_000;
const COLLECT_LIMIT = 40;

app.get("/api/health", (c) => c.json({ ok: true, name: c.env.APP_NAME ?? "Cairn", cookieless: true, gdpr: { export: "/api/export", erase: "/api/account/erase", retention_days_free: 14, retention_days_paid: 1095 } }));

app.get("/api/demo", (c) => c.json(demoBoard()));

app.get("/api/me", async (c) => {
  const user = await getSessionUser(c);
  if (!user) return c.json({ user: null }, 401);
  const count = await countLaunches(c.env.DB, user.id);
  return c.json({ user: publicUser(user, count), retention_ms: retentionMs(user.plan) });
});

app.get("/api/export", async (c) => {
  const user = await getSessionUser(c);
  if (!user) return c.json({ error: "Unauthorized" }, 401);
  const payload = await exportAccount(c.env.DB, user.id);
  return c.json(payload);
});

app.post("/api/account/erase", async (c) => {
  const user = await getSessionUser(c);
  if (!user) return c.json({ error: "Unauthorized" }, 401);
  const body = await c.req.json().catch(() => ({})) as { confirm?: string };
  if (body.confirm !== user.email) return c.json({ error: "Type your email to confirm erasure." }, 400);
  await eraseUser(c.env.DB, user.id, user.email);
  await destroySession(c);
  return c.json({ ok: true, erased: true });
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

app.get("/api/auth/providers", (c) => c.json({
  google: oauthConfigured(c.env, "google"),
  github: oauthConfigured(c.env, "github"),
  magic: true,
}));

app.get("/api/auth/google", (c) => startOAuth(c, "google", appOrigin(c)));
app.get("/api/auth/github", (c) => startOAuth(c, "github", appOrigin(c)));
app.get("/api/auth/google/callback", (c) => finishOAuth(c, "google", appOrigin(c)));
app.get("/api/auth/github/callback", (c) => finishOAuth(c, "github", appOrigin(c)));

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
    return c.json({ error: "Free accounts get one website. Upgrade to Pro to add more." }, 402);
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
  const board = await loadBoard(c.env.DB, launch, rangeSince(c.req.query("range"), launch.plan));
  return c.json({ ...board, watermark: showWatermark(launch), range: c.req.query("range") || "30d" });
});

app.get("/api/launches/:id/analytics", async (c) => {
  const user = await getSessionUser(c);
  if (!user) return c.json({ error: "Unauthorized" }, 401);
  const launch = await c.env.DB.prepare(
    "SELECT id, name, slug, site_url, manual_revenue_cents, created_at FROM launches WHERE id = ? AND user_id = ?",
  ).bind(c.req.param("id"), user.id).first<LaunchRow>();
  if (!launch) return c.json({ error: "Not found" }, 404);
  const board = await loadBoard(c.env.DB, launch, rangeSince(c.req.query("range"), user.plan));
  return c.json({ ...board, watermark: showWatermark(user), range: c.req.query("range") || "30d" });
});

app.use("/t/:slug/collect", cors({ origin: "*", allowMethods: ["POST", "OPTIONS"], allowHeaders: ["Content-Type"] }));

app.post("/t/:slug/collect", async (c) => {
  const slug = c.req.param("slug");
  const ip = c.req.header("cf-connecting-ip") || c.req.header("x-forwarded-for") || "0.0.0.0";
  const limited = await rateLimited(c.env.DB, `collect:${slug}:${ip}`, COLLECT_LIMIT, COLLECT_WINDOW_MS);
  if (limited) return c.json({ error: "rate_limited" }, 429);
  const launch = await c.env.DB.prepare("SELECT id, site_url FROM launches WHERE slug = ?").bind(slug).first<{ id: string; site_url: string | null }>();
  if (!launch) return c.json({ error: "not_found" }, 404);
  const body = await c.req.json().catch(() => ({})) as { t?: string; type?: string; p?: string; path?: string; r?: string; referrer?: string; amount_cents?: number; us?: string; um?: string; uc?: string; h?: string };
  const kindRaw = (body.t || body.type || "pageview").toLowerCase();
  const kind = kindRaw === "signup" || kindRaw === "payment" ? kindRaw : "pageview";
  const ua = c.req.header("user-agent") ?? "";
  const bot = isBot(ua) ? 1 : 0;
  const visitor_hash = await dayVisitorHash(ip, ua, c.env.SESSION_SECRET || "launchmap");
  const geo = jitter(geoFromCountry(c.req.header("cf-ipcountry")), visitor_hash);
  const amount = kind === "payment" && typeof body.amount_cents === "number" ? Math.max(0, Math.round(body.amount_cents)) : 0;
  const referrer = channelFromReferrer(body.r || body.referrer || c.req.header("referer") || "");
  const device = deviceFromUa(ua);
  const host = (body.h || "").slice(0, 120);
  if (launch.site_url) {
    try {
      const allowed = new URL(launch.site_url).hostname.replace(/^www\./, "");
      const got = host.replace(/^www\./, "") || (c.req.header("origin") ? new URL(c.req.header("origin")!).hostname.replace(/^www\./, "") : "");
      if (got && got !== allowed && got !== "localhost") return c.json({ error: "host_not_allowed" }, 403);
    } catch { /* site_url may be incomplete during setup */ }
  }
  await c.env.DB.prepare(
    "INSERT INTO events (id, launch_id, kind, visitor_hash, country, city, lat, lng, path, amount_cents, created_at, referrer, device, utm_source, utm_medium, utm_campaign, host, bot) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  ).bind(randomId(), launch.id, kind, visitor_hash, geo.country, geo.city, geo.lat, geo.lng, (body.p || body.path || "/").slice(0, 180), amount, Date.now(), referrer, device, (body.us || "").slice(0, 80) || null, (body.um || "").slice(0, 80) || null, (body.uc || "").slice(0, 80) || null, host || null, bot).run();
  return c.json({ ok: true, dropped: false });
});

app.get("/embed.js", (c) => {
  const origin = appOrigin(c);
  const js = `(function(){var s=document.currentScript;if(!s)return;var slug=s.getAttribute("data-slug");if(!slug)return;var o="${origin}";var q=new URLSearchParams(location.search);function ping(t,extra){try{fetch(o+"/t/"+encodeURIComponent(slug)+"/collect",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(Object.assign({t:t,p:location.pathname,r:document.referrer||"",h:location.hostname,us:q.get("utm_source")||"",um:q.get("utm_medium")||"",uc:q.get("utm_campaign")||""},extra||{})),mode:"cors",keepalive:true,credentials:"omit"});}catch(e){}}ping("pageview");window.cairnSignup=window.whypaidSignup=window.launchmapSignup=function(){ping("signup")};})();`;
  return new Response(js, { headers: { "content-type": "application/javascript; charset=utf-8", "cache-control": "public, max-age=300", "access-control-allow-origin": "*" } });
});

app.post("/api/checkout", async (c) => {
  const user = await getSessionUser(c);
  if (!user) return c.json({ error: "Unauthorized" }, 401);
  if (!c.env.DODO_PAYMENTS_API_KEY) return c.json({ error: "Dodo Payments is not configured. Set DODO_PAYMENTS_API_KEY." }, 500);
  const body = await c.req.json().catch(() => ({})) as { plan?: string; launch_id?: string };
  const plan = body.plan === "business" ? "business" : "pro";
  const productId = productIdForPlan(c.env, plan);
  if (!productId) return c.json({ error: plan === "business" ? "Set DODO_BUSINESS_PRODUCT_ID." : "Set DODO_PRO_PRODUCT_ID or DODO_MONTHLY_PRODUCT_ID." }, 500);
  try {
    const session = await createDodoCheckoutSession({
      apiKey: c.env.DODO_PAYMENTS_API_KEY,
      environment: c.env.DODO_PAYMENTS_ENVIRONMENT,
      productId,
      email: user.email,
      returnUrl: `${appOrigin(c)}/checkout/success`,
      metadata: { source: "cairn", email: user.email, user_id: user.id, plan, launch_id: body.launch_id ?? "" },
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
  await db.prepare("UPDATE users SET watermark = 0, dodo_customer_id = COALESCE(?, dodo_customer_id), dodo_payment_id = COALESCE(?, dodo_payment_id) WHERE id = ?").bind(customer?.customer_id ?? null, paymentId, userId).run();
  if (metadata.launch_id && amount > 0) {
    await db.prepare("INSERT INTO events (id, launch_id, kind, visitor_hash, country, city, lat, lng, path, amount_cents, created_at) VALUES (?, ?, ?, NULL, NULL, NULL, NULL, NULL, ?, ?, ?)").bind(randomId(), metadata.launch_id, "payment", "dodo", amount, now).run();
  }
}

async function onSubscriptionActive(db: D1Database, data: Record<string, unknown>): Promise<void> {
  const email = customerEmailFromDodoPayload(data);
  const customer = data.customer as { customer_id?: string } | undefined;
  const metadata = (data.metadata ?? {}) as { user_id?: string; email?: string; plan?: string };
  const subId = typeof data.subscription_id === "string" ? data.subscription_id : null;
  const plan = metadata.plan === "business" ? "business" : "pro";
  let userId = metadata.user_id;
  if (!userId) {
    const target = email ?? metadata.email?.toLowerCase();
    if (!target) return;
    userId = (await findOrCreateUser(db, target)).id;
  }
  await db.prepare("UPDATE users SET plan = ?, plan_status = ?, watermark = 0, dodo_customer_id = COALESCE(?, dodo_customer_id), dodo_subscription_id = COALESCE(?, dodo_subscription_id) WHERE id = ?").bind(plan, "active", customer?.customer_id ?? null, subId, userId).run();
}

type LaunchRow = { id: string; name: string; slug: string; site_url: string | null; manual_revenue_cents: number; created_at: number };

async function loadBoard(db: D1Database, launch: LaunchRow, since = 0) {
  const views = await db.prepare("SELECT COUNT(*) as n FROM events WHERE launch_id = ? AND bot = 0 AND created_at >= ? AND kind = ?").bind(launch.id, since, "pageview").first<{ n: number }>();
  const uniques = await db.prepare("SELECT COUNT(DISTINCT visitor_hash) as n FROM events WHERE launch_id = ? AND bot = 0 AND created_at >= ? AND kind = ?").bind(launch.id, since, "pageview").first<{ n: number }>();
  const signups = await db.prepare("SELECT COUNT(*) as n FROM events WHERE launch_id = ? AND bot = 0 AND created_at >= ? AND kind = ?").bind(launch.id, since, "signup").first<{ n: number }>();
  const paid = await db.prepare("SELECT COALESCE(SUM(amount_cents), 0) as n FROM events WHERE launch_id = ? AND bot = 0 AND created_at >= ? AND kind = ?").bind(launch.id, since, "payment").first<{ n: number }>();
  const { results } = await db.prepare("SELECT id, kind, country, city, lat, lng, path, amount_cents, created_at, referrer FROM events WHERE launch_id = ? AND bot = 0 AND created_at >= ? ORDER BY created_at DESC LIMIT 40").bind(launch.id, since).all<VisitorHit>();
  const pages = (await db.prepare("SELECT path, COUNT(*) as views FROM events WHERE launch_id = ? AND bot = 0 AND created_at >= ? AND kind = 'pageview' GROUP BY path ORDER BY views DESC LIMIT 8").bind(launch.id, since).all< { path: string; views: number }>()).results ?? [];
  const countries = (await db.prepare("SELECT country, COUNT(DISTINCT visitor_hash) as visitors FROM events WHERE launch_id = ? AND bot = 0 AND created_at >= ? AND country IS NOT NULL GROUP BY country ORDER BY visitors DESC LIMIT 8").bind(launch.id, since).all<{ country: string; visitors: number }>()).results ?? [];
  const sourceRows = (await db.prepare("SELECT COALESCE(referrer, 'Direct') as name, COUNT(DISTINCT visitor_hash) as visitors, COALESCE(SUM(CASE WHEN kind = 'payment' THEN amount_cents ELSE 0 END), 0) as revenue_cents FROM events WHERE launch_id = ? AND bot = 0 AND created_at >= ? GROUP BY COALESCE(referrer, 'Direct') ORDER BY visitors DESC LIMIT 8").bind(launch.id, since).all<{ name: string; visitors: number; revenue_cents: number }>()).results ?? [];
  const aiNames = new Set(["ChatGPT", "Perplexity", "Claude", "Gemini"]);
  const sources = sourceRows.filter((s) => !aiNames.has(s.name));
  const ai = sourceRows.filter((s) => aiNames.has(s.name));
  return {
    launch: { name: launch.name, slug: launch.slug, site_url: launch.site_url },
    stats: {
      views: views?.n ?? 0,
      unique: uniques?.n ?? 0,
      signups: signups?.n ?? 0,
      revenue_cents: (launch.manual_revenue_cents ?? 0) + (paid?.n ?? 0),
    },
    visitors: results ?? [],
    sources, pages, countries, ai, search: [],
  };
}

type VisitorHit = { id: string; kind: string; country: string | null; city: string | null; lat: number | null; lng: number | null; path: string | null; amount_cents: number; created_at: number; referrer?: string | null };

function channelFromReferrer(raw: string): string {
  if (!raw) return "Direct";
  let host = "";
  try { host = new URL(raw).hostname.replace(/^www\./, ""); } catch { return "Direct"; }
  if (/t\.co$|twitter\.com$|x\.com$/.test(host)) return "Twitter / X";
  if (/google\./.test(host)) return "Google";
  if (/producthunt\.com$/.test(host)) return "Product Hunt";
  if (/chatgpt\.com$|openai\.com$/.test(host)) return "ChatGPT";
  if (/perplexity\.ai$/.test(host)) return "Perplexity";
  if (/claude\.ai$|anthropic\.com$/.test(host)) return "Claude";
  if (/gemini\.google\.com$/.test(host)) return "Gemini";
  if (/reddit\.com$/.test(host)) return "Reddit";
  return host.slice(0, 48) || "Direct";
}

function deviceFromUa(ua: string): string {
  const u = ua.toLowerCase();
  if (/ipad|tablet/.test(u)) return "Tablet";
  if (/mobi|iphone|android/.test(u)) return "Mobile";
  return "Desktop";
}

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
  const tick = Math.max(0, Math.floor((now - Date.UTC(2026, 8, 2, 18, 0, 0)) / 5000));
  const views = 1299 + tick;
  const unique = 412 + Math.floor(tick / 3);
  const signups = 87 + Math.floor(tick / 8);
  const payments = 1 + Math.floor(tick / 400);
  const visitors = Array.from({ length: 12 }, (_, i) => {
    const city = cities[(tick + i * 3) % cities.length];
    const kind = i === 0 && tick % 22 === 0 ? "payment" : i % 5 === 0 ? "signup" : "pageview";
    return { id: `demo-${tick}-${i}`, kind, country: city.country, city: city.city, lat: city.lat, lng: city.lng, path: i % 2 ? "/" : "/pricing", amount_cents: kind === "payment" ? 1900 : 0, created_at: now - i * 2100 };
  });
  const revenue = payments * 1900;
  const sources = [
    { name: "Twitter / X", visitors: Math.floor(unique * 0.34), revenue_cents: Math.floor(revenue * 0.48) },
    { name: "Google", visitors: Math.floor(unique * 0.22), revenue_cents: Math.floor(revenue * 0.18) },
    { name: "Direct", visitors: Math.floor(unique * 0.18), revenue_cents: Math.floor(revenue * 0.12) },
    { name: "Product Hunt", visitors: Math.floor(unique * 0.14), revenue_cents: Math.floor(revenue * 0.09) },
  ];
  const pages = [
    { path: "/", views: Math.floor(views * 0.46) },
    { path: "/pricing", views: Math.floor(views * 0.28) },
    { path: "/blog/launch", views: Math.floor(views * 0.16) },
    { path: "/login", views: Math.floor(views * 0.1) },
  ];
  const countries = [
    { country: "US", visitors: Math.floor(unique * 0.38) },
    { country: "IN", visitors: Math.floor(unique * 0.18) },
    { country: "GB", visitors: Math.floor(unique * 0.12) },
    { country: "DE", visitors: Math.floor(unique * 0.1) },
    { country: "BR", visitors: Math.floor(unique * 0.08) },
  ];
  const search = [
    { query: "acme analytics alternative", clicks: 42 + Math.floor(tick / 40) },
    { query: "launch week tracker", clicks: 31 + Math.floor(tick / 55) },
    { query: "acme vs plausible", clicks: 18 + Math.floor(tick / 70) },
  ];
  const ai = [
    { name: "ChatGPT", visitors: Math.floor(unique * 0.08), revenue_cents: Math.floor(revenue * 0.09) },
    { name: "Perplexity", visitors: Math.floor(unique * 0.03), revenue_cents: Math.floor(revenue * 0.03) },
    { name: "Claude", visitors: Math.floor(unique * 0.01), revenue_cents: Math.floor(revenue * 0.01) },
  ];
  return {
    launch: { name: "Acme launch week", slug: "demo", site_url: "https://example.com" },
    stats: { views, unique, signups, revenue_cents: revenue },
    visitors,
    sources, pages, countries, search, ai,
    watermark: false, demo: true,
  };
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


function rangeSince(range: string | undefined, plan: string | undefined): number {
  const now = Date.now();
  const cap = retentionMs(plan === "monthly" ? "monthly" : "free");
  const ms = range === "24h" ? 86400000 : range === "7d" ? 86400000 * 7 : 86400000 * 30;
  return now - Math.min(ms, cap);
}

function slugify(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48);
}

export default {
  fetch: app.fetch,
  async scheduled(_event: ScheduledEvent, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(purgeExpiredEvents(env.DB));
  },
};

