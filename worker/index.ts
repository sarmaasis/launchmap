import { Hono, type Context } from "hono";
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
import { loadBoard, loadJourney, type LaunchRow } from "./lib/board";
import { embedScript } from "./embed";
import {
  applyRefund,
  asRecord,
  bumpHour,
  hourFloor,
  insertTrustedPayment,
  num,
  pickVid,
  resolveLaunchId,
  verifyStripeSignature,
} from "./lib/payments";
import {
  connectionStatus,
  deleteConnection,
  finishGscOAuth,
  listSearchRows,
  startGscOAuth,
  syncAllSearch,
  syncBing,
  syncGsc,
  upsertBingConnection,
} from "./lib/search";
import { createApiKey, deleteApiKey, getBearerUser, listApiKeys } from "./lib/apikeys";
import {
  handleLemonEvent,
  handlePaddleEvent,
  handlePolarEvent,
  verifyLemonSignature,
  verifyPaddleSignature,
  verifyPolarWebhook,
} from "./lib/provider-webhooks";

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
    await c.env.DB.prepare(
      "INSERT INTO launch_modes (launch_id, live, started_at, ended_at) VALUES (?, 1, ?, NULL)",
    ).bind(row.id, row.created_at).run();
  } catch {
    return c.json({ error: "That slug is taken." }, 409);
  }
  return c.json({ launch: { ...row, manual_revenue_cents: 0, public_url: `${appOrigin(c)}/l/${slug}` } }, 201);
});

app.patch("/api/launches/:id", async (c) => {
  const user = await getSessionUser(c);
  if (!user) return c.json({ error: "Unauthorized" }, 401);
  const body = await c.req.json().catch(() => ({})) as { name?: string; site_url?: string; manual_revenue_cents?: number; launch_mode?: boolean };
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
  if (typeof body.launch_mode === "boolean") {
    const now = Date.now();
    const live = body.launch_mode ? 1 : 0;
    await c.env.DB.prepare(
      `INSERT INTO launch_modes (launch_id, live, started_at, ended_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(launch_id) DO UPDATE SET
         live = excluded.live,
         started_at = CASE WHEN excluded.live = 1 THEN COALESCE(launch_modes.started_at, excluded.started_at) ELSE launch_modes.started_at END,
         ended_at = CASE WHEN excluded.live = 0 THEN excluded.ended_at ELSE NULL END`,
    ).bind(c.req.param("id"), live, now, live ? null : now).run();
  }
  return c.json({ ok: true });
});


app.get("/api/connect/gsc", async (c) => {
  const user = await getSessionUser(c);
  if (!user) return c.json({ error: "Unauthorized" }, 401);
  const launchId = (c.req.query("launch_id") ?? "").trim();
  if (!launchId) return c.json({ error: "launch_id is required" }, 400);
  const launch = await c.env.DB.prepare("SELECT id FROM launches WHERE id = ? AND user_id = ?").bind(launchId, user.id).first();
  if (!launch) return c.json({ error: "Not found" }, 404);
  return startGscOAuth(c, appOrigin(c), launchId, user.id);
});
app.get("/api/connect/gsc/callback", (c) => finishGscOAuth(c, appOrigin(c)));

app.post("/api/launches/:id/connect/bing", async (c) => {
  const user = await getSessionUser(c);
  if (!user) return c.json({ error: "Unauthorized" }, 401);
  const launch = await c.env.DB.prepare(
    "SELECT id, name, slug, site_url, manual_revenue_cents, created_at FROM launches WHERE id = ? AND user_id = ?",
  ).bind(c.req.param("id"), user.id).first<LaunchRow>();
  if (!launch) return c.json({ error: "Not found" }, 404);
  const body = await c.req.json().catch(() => ({})) as { api_key?: string; site_url?: string };
  const apiKey = (body.api_key ?? "").trim();
  if (!apiKey) return c.json({ error: "api_key is required" }, 400);
  const siteUrl = (body.site_url ?? launch.site_url ?? "").trim() || null;
  await upsertBingConnection(c.env.DB, user.id, launch.id, apiKey, siteUrl);
  try { await syncBing(c.env, launch); } catch (err) { console.error("bing sync after connect failed", err); }
  return c.json({ ok: true, connections: await connectionStatus(c.env.DB, launch.id) });
});

app.delete("/api/launches/:id/connect/gsc", async (c) => {
  const user = await getSessionUser(c);
  if (!user) return c.json({ error: "Unauthorized" }, 401);
  const launch = await c.env.DB.prepare("SELECT id FROM launches WHERE id = ? AND user_id = ?").bind(c.req.param("id"), user.id).first();
  if (!launch) return c.json({ error: "Not found" }, 404);
  await deleteConnection(c.env.DB, c.req.param("id"), "gsc");
  return c.json({ ok: true });
});

app.delete("/api/launches/:id/connect/bing", async (c) => {
  const user = await getSessionUser(c);
  if (!user) return c.json({ error: "Unauthorized" }, 401);
  const launch = await c.env.DB.prepare("SELECT id FROM launches WHERE id = ? AND user_id = ?").bind(c.req.param("id"), user.id).first();
  if (!launch) return c.json({ error: "Not found" }, 404);
  await deleteConnection(c.env.DB, c.req.param("id"), "bing");
  return c.json({ ok: true });
});

app.get("/api/launches/:id/connections", async (c) => {
  const user = await getSessionUser(c);
  if (!user) return c.json({ error: "Unauthorized" }, 401);
  const launch = await c.env.DB.prepare("SELECT id FROM launches WHERE id = ? AND user_id = ?").bind(c.req.param("id"), user.id).first();
  if (!launch) return c.json({ error: "Not found" }, 404);
  return c.json(await connectionStatus(c.env.DB, c.req.param("id")));
});

app.get("/api/launches/:id/search", async (c) => {
  const user = await getSessionUser(c);
  if (!user) return c.json({ error: "Unauthorized" }, 401);
  const launch = await c.env.DB.prepare("SELECT id FROM launches WHERE id = ? AND user_id = ?").bind(c.req.param("id"), user.id).first();
  if (!launch) return c.json({ error: "Not found" }, 404);
  return c.json(await listSearchRows(c.env.DB, c.req.param("id")));
});

app.post("/api/launches/:id/search/sync", async (c) => {
  const user = await getSessionUser(c);
  if (!user) return c.json({ error: "Unauthorized" }, 401);
  const launch = await c.env.DB.prepare(
    "SELECT id, name, slug, site_url, manual_revenue_cents, created_at FROM launches WHERE id = ? AND user_id = ?",
  ).bind(c.req.param("id"), user.id).first<LaunchRow>();
  if (!launch) return c.json({ error: "Not found" }, 404);
  await syncGsc(c.env, launch);
  await syncBing(c.env, launch);
  return c.json({ ok: true, search: await listSearchRows(c.env.DB, launch.id) });
});

app.post("/api/keys", async (c) => {
  const user = await getSessionUser(c);
  if (!user) return c.json({ error: "Unauthorized" }, 401);
  const body = await c.req.json().catch(() => ({})) as { name?: string };
  const name = (body.name ?? "CLI").trim() || "CLI";
  const key = await createApiKey(c.env.DB, c.env.SESSION_SECRET, user.id, name);
  return c.json({ key }, 201);
});

app.get("/api/keys", async (c) => {
  const user = await getSessionUser(c);
  if (!user) return c.json({ error: "Unauthorized" }, 401);
  return c.json({ keys: await listApiKeys(c.env.DB, user.id) });
});

app.delete("/api/keys/:id", async (c) => {
  const user = await getSessionUser(c);
  if (!user) return c.json({ error: "Unauthorized" }, 401);
  const ok = await deleteApiKey(c.env.DB, user.id, c.req.param("id"));
  if (!ok) return c.json({ error: "Not found" }, 404);
  return c.json({ ok: true });
});

async function requireBearerLaunch(c: Context<{ Bindings: Env }>, id: string) {
  const user = await getBearerUser(c);
  if (!user) return { error: c.json({ error: "Unauthorized" }, 401), user: null, launch: null };
  const launch = await c.env.DB.prepare(
    "SELECT id, name, slug, site_url, manual_revenue_cents, created_at FROM launches WHERE id = ? AND user_id = ?",
  ).bind(id, user.id).first<LaunchRow>();
  if (!launch) return { error: c.json({ error: "Not found" }, 404), user, launch: null };
  return { error: null, user, launch };
}

app.get("/api/v1/me", async (c) => {
  const user = await getBearerUser(c);
  if (!user) return c.json({ error: "Unauthorized" }, 401);
  const count = await countLaunches(c.env.DB, user.id);
  return c.json({ user: publicUser(user, count), retention_ms: retentionMs(user.plan) });
});

app.get("/api/v1/sites", async (c) => {
  const user = await getBearerUser(c);
  if (!user) return c.json({ error: "Unauthorized" }, 401);
  const { results } = await c.env.DB.prepare(
    "SELECT id, name, slug, site_url, created_at FROM launches WHERE user_id = ? ORDER BY created_at DESC",
  ).bind(user.id).all();
  return c.json({ sites: results ?? [] });
});

app.get("/api/v1/sites/:id/overview", async (c) => {
  const got = await requireBearerLaunch(c, c.req.param("id"));
  if (got.error || !got.launch || !got.user) return got.error!;
  const board = await loadBoard(c.env.DB, got.launch, rangeSince(c.req.query("range"), got.user.plan));
  return c.json({ launch: board.launch, stats: board.stats, series: board.series, live: board.live, range: c.req.query("range") || "30d" });
});

app.get("/api/v1/sites/:id/sources", async (c) => {
  const got = await requireBearerLaunch(c, c.req.param("id"));
  if (got.error || !got.launch || !got.user) return got.error!;
  const board = await loadBoard(c.env.DB, got.launch, rangeSince(c.req.query("range"), got.user.plan), touchFromQuery(c.req.query("touch")));
  return c.json({ sources: board.sources, sources_last: board.sources_last, ai: board.ai, touch: board.touch });
});

app.get("/api/v1/sites/:id/search", async (c) => {
  const got = await requireBearerLaunch(c, c.req.param("id"));
  if (got.error || !got.launch) return got.error!;
  const board = await loadBoard(c.env.DB, got.launch, rangeSince(c.req.query("range"), got.user?.plan));
  return c.json({ search: board.search, rows: await listSearchRows(c.env.DB, got.launch.id) });
});

app.get("/api/v1/sites/:id/funnel", async (c) => {
  const got = await requireBearerLaunch(c, c.req.param("id"));
  if (got.error || !got.launch || !got.user) return got.error!;
  const board = await loadBoard(c.env.DB, got.launch, rangeSince(c.req.query("range"), got.user.plan));
  return c.json({ funnel: board.funnel });
});

app.get("/api/v1/sites/:id/feed", async (c) => {
  const got = await requireBearerLaunch(c, c.req.param("id"));
  if (got.error || !got.launch || !got.user) return got.error!;
  const board = await loadBoard(c.env.DB, got.launch, rangeSince(c.req.query("range"), got.user.plan));
  return c.json({ visitors: board.visitors });
});

app.get("/api/public/:slug", async (c) => {
  const slug = c.req.param("slug");
  const launch = await c.env.DB.prepare(
    "SELECT launches.id, launches.name, launches.slug, launches.site_url, launches.manual_revenue_cents, launches.created_at, users.plan, users.watermark FROM launches JOIN users ON users.id = launches.user_id WHERE launches.slug = ?",
  ).bind(slug).first<LaunchRow & { plan: string; watermark: number }>();
  if (!launch) return c.json({ error: "Not found" }, 404);
  const board = await loadBoard(c.env.DB, launch, rangeSince(c.req.query("range"), launch.plan), touchFromQuery(c.req.query("touch")));
  return c.json({ ...board, watermark: showWatermark(launch), range: c.req.query("range") || "30d" });
});

app.get("/api/launches/:id/analytics", async (c) => {
  const user = await getSessionUser(c);
  if (!user) return c.json({ error: "Unauthorized" }, 401);
  const launch = await c.env.DB.prepare(
    "SELECT id, name, slug, site_url, manual_revenue_cents, created_at FROM launches WHERE id = ? AND user_id = ?",
  ).bind(c.req.param("id"), user.id).first<LaunchRow>();
  if (!launch) return c.json({ error: "Not found" }, 404);
  const board = await loadBoard(c.env.DB, launch, rangeSince(c.req.query("range"), user.plan), touchFromQuery(c.req.query("touch")));
  return c.json({ ...board, watermark: showWatermark(user), range: c.req.query("range") || "30d" });
});

app.get("/api/launches/:id/journey/:vid", async (c) => {
  const user = await getSessionUser(c);
  if (!user) return c.json({ error: "Unauthorized" }, 401);
  const launch = await c.env.DB.prepare("SELECT id FROM launches WHERE id = ? AND user_id = ?").bind(c.req.param("id"), user.id).first();
  if (!launch) return c.json({ error: "Not found" }, 404);
  const vid = c.req.param("vid");
  if (!vid) return c.json({ error: "Missing visitor" }, 400);
  const journey = await loadJourney(c.env.DB, c.req.param("id"), vid);
  return c.json(journey);
});

app.use("/t/:slug/collect", cors({ origin: "*", allowMethods: ["POST", "OPTIONS"], allowHeaders: ["Content-Type"] }));

app.post("/t/:slug/collect", async (c) => {
  const slug = c.req.param("slug");
  const ip = c.req.header("cf-connecting-ip") || c.req.header("x-forwarded-for") || "0.0.0.0";
  const limited = await rateLimited(c.env.DB, `collect:${slug}:${ip}`, COLLECT_LIMIT, COLLECT_WINDOW_MS);
  if (limited) return c.json({ error: "rate_limited" }, 429);
  const launch = await c.env.DB.prepare("SELECT id, site_url FROM launches WHERE slug = ?").bind(slug).first<{ id: string; site_url: string | null }>();
  if (!launch) return c.json({ error: "not_found" }, 404);
  const body = await c.req.json().catch(() => ({})) as {
    t?: string; type?: string; p?: string; path?: string; r?: string; referrer?: string; amount_cents?: number;
    us?: string; um?: string; uc?: string; h?: string; vid?: string; n?: string; name?: string; land?: string;
  };
  const kindRaw = (body.t || body.type || "pageview").toLowerCase();
  const kind = kindRaw === "signup" || kindRaw === "payment" || kindRaw === "event" ? kindRaw : "pageview";
  const ua = c.req.header("user-agent") ?? "";
  const bot = isBot(ua) ? 1 : 0;
  const visitor_hash = await dayVisitorHash(ip, ua, c.env.SESSION_SECRET || "launchmap");
  const geo = jitter(geoFromCountry(c.req.header("cf-ipcountry")), visitor_hash);
  const amount = kind === "payment" && typeof body.amount_cents === "number" ? Math.max(0, Math.round(body.amount_cents)) : 0;
  const referrer = channelFromReferrer(body.r || body.referrer || c.req.header("referer") || "");
  const device = deviceFromUa(ua);
  const host = (body.h || "").slice(0, 120);
  const path = (body.p || body.path || "/").slice(0, 180);
  const vid = typeof body.vid === "string" && body.vid.trim().length >= 8 ? body.vid.trim().slice(0, 64) : null;
  const eventName = kind === "event" ? String(body.n || body.name || "event").slice(0, 80) : null;
  const land = typeof body.land === "string" && body.land.trim() ? body.land.trim().slice(0, 180) : path;
  const us = (body.us || "").slice(0, 80) || null;
  const um = (body.um || "").slice(0, 80) || null;
  const uc = (body.uc || "").slice(0, 80) || null;
  if (launch.site_url) {
    try {
      const allowed = new URL(launch.site_url).hostname.replace(/^www\./, "");
      const got = host.replace(/^www\./, "") || (c.req.header("origin") ? new URL(c.req.header("origin")!).hostname.replace(/^www\./, "") : "");
      if (got && got !== allowed && got !== "localhost") return c.json({ error: "host_not_allowed" }, 403);
    } catch { /* site_url may be incomplete during setup */ }
  }
  const now = Date.now();
  if (!bot && vid) {
    await c.env.DB.prepare(
      `INSERT INTO visitors (id, launch_id, first_at, last_at, first_path, last_path, first_referrer, last_referrer, first_utm_source, first_utm_medium, first_utm_campaign, last_utm_source, last_utm_medium, last_utm_campaign, country, device)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(launch_id, id) DO UPDATE SET
         last_at = excluded.last_at,
         last_path = excluded.last_path,
         last_referrer = excluded.last_referrer,
         last_utm_source = excluded.last_utm_source,
         last_utm_medium = excluded.last_utm_medium,
         last_utm_campaign = excluded.last_utm_campaign,
         country = COALESCE(excluded.country, visitors.country),
         device = COALESCE(excluded.device, visitors.device)`,
    ).bind(vid, launch.id, now, now, land, path, referrer, referrer, us, um, uc, us, um, uc, geo.country, device).run();
  }
  const hourTs = hourFloor(now);
  let uniqueInc = 0;
  if (!bot && kind === "pageview") {
    const key = vid || visitor_hash;
    const seen = key
      ? await c.env.DB.prepare(
        "SELECT 1 as n FROM events WHERE launch_id = ? AND created_at >= ? AND created_at < ? AND bot = 0 AND COALESCE(NULLIF(vid, ''), visitor_hash) = ? LIMIT 1",
      ).bind(launch.id, hourTs, hourTs + 3_600_000, key).first()
      : null;
    uniqueInc = seen ? 0 : 1;
  }
  await c.env.DB.prepare(
    "INSERT INTO events (id, launch_id, kind, visitor_hash, country, city, lat, lng, path, amount_cents, created_at, referrer, device, utm_source, utm_medium, utm_campaign, host, bot, vid, name) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  ).bind(randomId(), launch.id, kind, visitor_hash, geo.country, geo.city, geo.lat, geo.lng, path, amount, now, referrer, device, us, um, uc, host || null, bot, vid, eventName).run();
  if (!bot) {
    await bumpHour(c.env.DB, launch.id, hourTs, {
      views: kind === "pageview" ? 1 : 0,
      uniques: uniqueInc,
      signups: kind === "signup" ? 1 : 0,
    });
  }
  return c.json({ ok: true, dropped: false, unverified: kind === "payment" });
});

app.get("/embed.js", (c) => {
  const js = embedScript(appOrigin(c));
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
  const type = (event.type ?? "").toLowerCase();
  if (event.type === "payment.succeeded") await onPaymentSucceeded(c.env.DB, event.data ?? {});
  if (event.type === "subscription.active") await onSubscriptionActive(c.env.DB, event.data ?? {});
  if (type.includes("refund")) await onDodoRefund(c.env.DB, event.data ?? {});
  return c.json({ received: true });
});

app.post("/webhooks/stripe", async (c) => {
  const secret = c.env.STRIPE_WEBHOOK_SECRET;
  if (!secret) return c.json({ error: "STRIPE_WEBHOOK_SECRET is not configured" }, 500);
  const rawBody = await c.req.text();
  const ok = await verifyStripeSignature(rawBody, c.req.header("stripe-signature"), secret);
  if (!ok) return c.json({ error: "Invalid signature" }, 401);
  let event: { id?: string; type?: string; data?: { object?: Record<string, unknown> } };
  try { event = JSON.parse(rawBody) as { id?: string; type?: string; data?: { object?: Record<string, unknown> } }; }
  catch { return c.json({ error: "Invalid JSON" }, 400); }
  const eventId = event.id || "";
  if (eventId) {
    const existing = await c.env.DB.prepare("SELECT webhook_id FROM webhook_events WHERE webhook_id = ?").bind(eventId).first();
    if (existing) return c.json({ received: true, duplicate: true });
    await c.env.DB.prepare("INSERT INTO webhook_events (webhook_id, event_type, payload, processed_at) VALUES (?, ?, ?, ?)").bind(eventId, event.type ?? "unknown", rawBody, Date.now()).run();
  }
  const obj = asRecord(event.data?.object);
  const meta = asRecord(obj.metadata);
  const type = event.type ?? "";
  if (type === "checkout.session.completed" || type === "payment_intent.succeeded") {
    const launchId = await resolveLaunchId(c.env.DB, meta);
    if (launchId) {
      const vid = pickVid(meta, typeof obj.client_reference_id === "string" ? obj.client_reference_id : null);
      const amount = type === "checkout.session.completed" ? num(obj.amount_total) : num(obj.amount);
      const currency = typeof obj.currency === "string" ? obj.currency : "usd";
      const external = (typeof obj.payment_intent === "string" ? obj.payment_intent : null) || (typeof obj.id === "string" ? obj.id : null);
      await insertTrustedPayment(c.env.DB, {
        launchId,
        vid,
        provider: "stripe",
        amount_cents: amount,
        kind: "one_time",
        currency,
        external_id: external,
      });
    }
  } else if (type === "customer.subscription.created") {
    const launchId = await resolveLaunchId(c.env.DB, meta);
    if (launchId) {
      const items = asRecord((obj.items as { data?: unknown[] } | undefined)?.data?.[0]);
      const price = asRecord(items.price || items.plan);
      const planObj = asRecord(obj.plan);
      const amount = num(price.unit_amount ?? planObj.amount);
      await insertTrustedPayment(c.env.DB, {
        launchId,
        vid: pickVid(meta),
        provider: "stripe",
        amount_cents: amount,
        kind: "subscription",
        currency: typeof obj.currency === "string" ? obj.currency : typeof price.currency === "string" ? price.currency : "usd",
        external_id: typeof obj.id === "string" ? obj.id : null,
      });
    }
  } else if (type === "charge.refunded") {
    const ids = [typeof obj.id === "string" ? obj.id : "", typeof obj.payment_intent === "string" ? obj.payment_intent : ""].filter(Boolean);
    await applyRefund(c.env.DB, "stripe", ids, num(obj.amount_refunded ?? obj.amount));
  }
  return c.json({ received: true });
});


app.post("/webhooks/polar", async (c) => {
  const secret = c.env.POLAR_WEBHOOK_SECRET;
  if (!secret) return c.json({ error: "POLAR_WEBHOOK_SECRET is not configured" }, 500);
  const rawBody = await c.req.text();
  const ok = await verifyPolarWebhook(rawBody, {
    id: c.req.header("webhook-id"),
    timestamp: c.req.header("webhook-timestamp"),
    signature: c.req.header("webhook-signature"),
    polarSignature: c.req.header("polar-signature") || c.req.header("Polar-Signature"),
  }, secret);
  if (!ok) return c.json({ error: "Invalid signature" }, 401);
  let event: { type?: string; data?: unknown; id?: string };
  try { event = JSON.parse(rawBody) as { type?: string; data?: unknown; id?: string }; }
  catch { return c.json({ error: "Invalid JSON" }, 400); }
  const eventId = c.req.header("webhook-id") || (typeof event.id === "string" ? event.id : "");
  if (eventId) {
    const existing = await c.env.DB.prepare("SELECT webhook_id FROM webhook_events WHERE webhook_id = ?").bind(eventId).first();
    if (existing) return c.json({ received: true, duplicate: true });
    await c.env.DB.prepare("INSERT INTO webhook_events (webhook_id, event_type, payload, processed_at) VALUES (?, ?, ?, ?)").bind(eventId, event.type ?? "unknown", rawBody, Date.now()).run();
  }
  await handlePolarEvent(c.env.DB, event);
  return c.json({ received: true });
});

app.post("/webhooks/paddle", async (c) => {
  const secret = c.env.PADDLE_WEBHOOK_SECRET;
  if (!secret) return c.json({ error: "PADDLE_WEBHOOK_SECRET is not configured" }, 500);
  const rawBody = await c.req.text();
  const ok = await verifyPaddleSignature(rawBody, c.req.header("paddle-signature") || c.req.header("Paddle-Signature"), secret);
  if (!ok) return c.json({ error: "Invalid signature" }, 401);
  let event: { event_id?: string; event_type?: string; data?: unknown };
  try { event = JSON.parse(rawBody) as { event_id?: string; event_type?: string; data?: unknown }; }
  catch { return c.json({ error: "Invalid JSON" }, 400); }
  const eventId = event.event_id || "";
  if (eventId) {
    const existing = await c.env.DB.prepare("SELECT webhook_id FROM webhook_events WHERE webhook_id = ?").bind(eventId).first();
    if (existing) return c.json({ received: true, duplicate: true });
    await c.env.DB.prepare("INSERT INTO webhook_events (webhook_id, event_type, payload, processed_at) VALUES (?, ?, ?, ?)").bind(eventId, event.event_type ?? "unknown", rawBody, Date.now()).run();
  }
  await handlePaddleEvent(c.env.DB, event);
  return c.json({ received: true });
});

app.post("/webhooks/lemon", async (c) => {
  const secret = c.env.LEMON_SQUEEZY_WEBHOOK_SECRET;
  if (!secret) return c.json({ error: "LEMON_SQUEEZY_WEBHOOK_SECRET is not configured" }, 500);
  const rawBody = await c.req.text();
  const ok = await verifyLemonSignature(rawBody, c.req.header("x-signature") || c.req.header("X-Signature"), secret);
  if (!ok) return c.json({ error: "Invalid signature" }, 401);
  let payload: Record<string, unknown>;
  try { payload = JSON.parse(rawBody) as Record<string, unknown>; }
  catch { return c.json({ error: "Invalid JSON" }, 400); }
  const meta = asRecord(payload.meta);
  const eventId = typeof meta.webhook_id === "string" ? meta.webhook_id : typeof payload.id === "string" ? payload.id : "";
  if (eventId) {
    const existing = await c.env.DB.prepare("SELECT webhook_id FROM webhook_events WHERE webhook_id = ?").bind(eventId).first();
    if (existing) return c.json({ received: true, duplicate: true });
    await c.env.DB.prepare("INSERT INTO webhook_events (webhook_id, event_type, payload, processed_at) VALUES (?, ?, ?, ?)").bind(eventId, String(meta.event_name ?? "unknown"), rawBody, Date.now()).run();
  }
  await handleLemonEvent(c.env.DB, payload);
  return c.json({ received: true });
});

async function onPaymentSucceeded(db: D1Database, data: Record<string, unknown>): Promise<void> {
  const email = customerEmailFromDodoPayload(data);
  const paymentId = typeof data.payment_id === "string" ? data.payment_id : null;
  const customer = data.customer as { customer_id?: string } | undefined;
  const metadata = asRecord(data.metadata);
  const amount = typeof data.total_amount === "number" ? data.total_amount : typeof data.amount === "number" ? data.amount : 0;
  let userId = typeof metadata.user_id === "string" ? metadata.user_id : undefined;
  if (!userId) {
    const target = email ?? (typeof metadata.email === "string" ? metadata.email.toLowerCase() : undefined);
    if (target) {
      const user = await findOrCreateUser(db, target);
      userId = user.id;
    }
  }
  if (userId) {
    await db.prepare("UPDATE users SET watermark = 0, dodo_customer_id = COALESCE(?, dodo_customer_id), dodo_payment_id = COALESCE(?, dodo_payment_id) WHERE id = ?").bind(customer?.customer_id ?? null, paymentId, userId).run();
  }
  const vid = pickVid(metadata);
  const launchId = vid ? await resolveLaunchId(db, metadata) : null;
  if (launchId && vid) {
    await insertTrustedPayment(db, {
      launchId,
      vid,
      provider: "dodo",
      amount_cents: amount,
      kind: "one_time",
      currency: typeof data.currency === "string" ? data.currency : "usd",
      external_id: paymentId,
    });
  }
}

async function onDodoRefund(db: D1Database, data: Record<string, unknown>): Promise<void> {
  const paymentId = typeof data.payment_id === "string" ? data.payment_id : typeof data.id === "string" ? data.id : "";
  const amount = num(data.total_amount ?? data.amount);
  await applyRefund(db, "dodo", [paymentId], amount);
}

async function onSubscriptionActive(db: D1Database, data: Record<string, unknown>): Promise<void> {
  const email = customerEmailFromDodoPayload(data);
  const customer = data.customer as { customer_id?: string } | undefined;
  const metadata = asRecord(data.metadata);
  const subId = typeof data.subscription_id === "string" ? data.subscription_id : null;
  const plan = metadata.plan === "business" ? "business" : "pro";
  let userId = typeof metadata.user_id === "string" ? metadata.user_id : undefined;
  if (!userId) {
    const target = email ?? (typeof metadata.email === "string" ? metadata.email.toLowerCase() : undefined);
    if (!target) return;
    userId = (await findOrCreateUser(db, target)).id;
  }
  await db.prepare("UPDATE users SET plan = ?, plan_status = ?, watermark = 0, dodo_customer_id = COALESCE(?, dodo_customer_id), dodo_subscription_id = COALESCE(?, dodo_subscription_id) WHERE id = ?").bind(plan, "active", customer?.customer_id ?? null, subId, userId).run();
}

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
    const kind = i === 0 && tick % 22 === 0 ? "payment" : i % 5 === 0 ? "signup" : i % 3 === 0 ? "event" : "pageview";
    return {
      id: `demo-${tick}-${i}`,
      vid: `demo-vid-${(tick + i) % 9}`,
      kind,
      name: kind === "event" ? "pricing_click" : kind === "payment" ? "payment" : null,
      country: city.country,
      city: city.city,
      lat: city.lat,
      lng: city.lng,
      path: i % 2 ? "/" : "/pricing",
      referrer: i % 3 === 0 ? "Twitter / X" : i % 3 === 1 ? "Google" : "Direct",
      amount_cents: kind === "payment" ? 1900 : 0,
      created_at: now - i * 2100,
      unverified: false,
    };
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
  const ai = [
    { name: "ChatGPT", visitors: Math.floor(unique * 0.08), revenue_cents: Math.floor(revenue * 0.09) },
    { name: "Perplexity", visitors: Math.floor(unique * 0.03), revenue_cents: Math.floor(revenue * 0.03) },
    { name: "Claude", visitors: Math.floor(unique * 0.01), revenue_cents: Math.floor(revenue * 0.01) },
  ];
  const series = Array.from({ length: 24 }, (_, i) => {
    const hour_ts = hourFloor(now) - (23 - i) * 3_600_000;
    const wave = ((tick + i * 7) % 40);
    return {
      hour_ts,
      views: 28 + wave + (i % 5) * 3,
      uniques: 9 + Math.floor(wave / 3),
      signups: i % 6 === 0 ? 2 : i % 3 === 0 ? 1 : 0,
      revenue_cents: i % 5 === 0 ? 1900 : 0,
    };
  });
  return {
    launch: { name: "Acme launch week", slug: "demo", site_url: "https://example.com" },
    stats: { views, unique, signups, revenue_cents: revenue, customers: payments, rpv: unique ? revenue / unique : 0 },
    visitors,
    sources,
    sources_last: sources.map((s) => ({ ...s, revenue_cents: Math.floor(s.revenue_cents * 0.85) })),
    pages, countries, search: [
      { query: "acme pricing (demo)", clicks: 48, engine: "gsc" },
      { query: "acme vs competitors (demo)", clicks: 21, engine: "bing" },
    ], ai, series,
    funnel: [
      { name: "Land", count: unique },
      { name: "Pricing", count: Math.floor(unique * 0.42) },
      { name: "Checkout", count: Math.floor(unique * 0.11) },
      { name: "Paid", count: payments },
    ],
    touch: "first",
    live: true,
    watermark: false,
    demo: true,
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
  const cap = retentionMs(plan ?? "free");
  const ms = range === "24h" ? 86400000 : range === "7d" ? 86400000 * 7 : 86400000 * 30;
  return now - Math.min(ms, cap);
}

function touchFromQuery(value: string | undefined): "first" | "last" {
  return value === "last" ? "last" : "first";
}

function slugify(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48);
}

export default {
  fetch: app.fetch,
  async scheduled(_event: ScheduledEvent, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil((async () => {
      await purgeExpiredEvents(env.DB);
      await syncAllSearch(env);
    })());
  },
};
