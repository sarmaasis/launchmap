import type { Context } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { randomId, randomToken } from "./crypto";
import type { LaunchRow } from "./board";

const GSC_STATE = "gsc_oauth_state";
const GSC_LAUNCH = "gsc_oauth_launch";
const STATE_TTL = 60 * 10;
const GSC_SCOPE = "https://www.googleapis.com/auth/webmasters.readonly openid email";

type ConnectionRow = {
  id: string;
  user_id: string;
  launch_id: string;
  kind: string;
  access_json: string | null;
  site_url: string | null;
};

function isoDay(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function hostnameOf(value: string): string {
  const v = value.trim();
  if (v.toLowerCase().startsWith("sc-domain:")) {
    return v.slice("sc-domain:".length).replace(/^www\./, "").toLowerCase();
  }
  try {
    const url = v.includes("://") ? new URL(v) : new URL(`https://${v}`);
    return url.hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return v.replace(/^https?:\/\//, "").replace(/^www\./, "").split("/")[0]?.toLowerCase() ?? "";
  }
}

function hostMatches(launchHost: string, property: string): boolean {
  const propHost = hostnameOf(property);
  if (!launchHost || !propHost) return false;
  if (launchHost === propHost) return true;
  if (property.toLowerCase().startsWith("sc-domain:") && (launchHost === propHost || launchHost.endsWith(`.${propHost}`))) {
    return true;
  }
  return false;
}

function isSecure(c: Context): boolean {
  const proto = c.req.header("x-forwarded-proto");
  if (proto) return proto === "https";
  return new URL(c.req.url).protocol === "https:";
}

export function gscOAuthConfigured(env: Env): boolean {
  return Boolean(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET);
}

export function startGscOAuth(c: Context<{ Bindings: Env }>, origin: string, launchId: string, userId: string): Response {
  if (!gscOAuthConfigured(c.env)) {
    return c.json({ error: "Google OAuth is not configured. Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET." }, 500);
  }
  const state = randomToken(24);
  const secure = isSecure(c);
  setCookie(c, GSC_STATE, state, { httpOnly: true, secure, sameSite: "Lax", path: "/", maxAge: STATE_TTL });
  setCookie(c, GSC_LAUNCH, `${launchId}:${userId}`, { httpOnly: true, secure, sameSite: "Lax", path: "/", maxAge: STATE_TTL });
  const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  url.searchParams.set("client_id", c.env.GOOGLE_CLIENT_ID!);
  url.searchParams.set("redirect_uri", `${origin}/api/connect/gsc/callback`);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", GSC_SCOPE);
  url.searchParams.set("state", state);
  url.searchParams.set("access_type", "offline");
  url.searchParams.set("prompt", "consent");
  url.searchParams.set("include_granted_scopes", "true");
  return c.redirect(url.toString());
}

export async function finishGscOAuth(c: Context<{ Bindings: Env }>, origin: string): Promise<Response> {
  const code = c.req.query("code");
  const state = c.req.query("state");
  const saved = getCookie(c, GSC_STATE);
  const launchCookie = getCookie(c, GSC_LAUNCH);
  deleteCookie(c, GSC_STATE, { path: "/" });
  deleteCookie(c, GSC_LAUNCH, { path: "/" });
  if (!code || !state || !saved || state !== saved || !launchCookie) {
    return c.redirect("/app?error=gsc_oauth_state");
  }
  const [launchId, userId] = launchCookie.split(":");
  if (!launchId || !userId) return c.redirect("/app?error=gsc_oauth_state");
  if (!gscOAuthConfigured(c.env)) return c.redirect("/app?error=gsc_oauth_not_configured");
  const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: c.env.GOOGLE_CLIENT_ID!,
      client_secret: c.env.GOOGLE_CLIENT_SECRET!,
      redirect_uri: `${origin}/api/connect/gsc/callback`,
      grant_type: "authorization_code",
    }),
  });
  const token = await tokenRes.json() as { refresh_token?: string; access_token?: string };
  if (!token.refresh_token) return c.redirect("/app?error=gsc_no_refresh_token");
  const launch = await c.env.DB.prepare(
    "SELECT id, name, slug, site_url, manual_revenue_cents, created_at FROM launches WHERE id = ? AND user_id = ?",
  ).bind(launchId, userId).first<LaunchRow>();
  if (!launch) return c.redirect("/app?error=gsc_launch_missing");
  const siteUrl = await pickGscProperty(token.access_token ?? "", launch.site_url);
  const now = Date.now();
  const access = JSON.stringify({ refresh_token: token.refresh_token });
  const existing = await c.env.DB.prepare(
    "SELECT id FROM connections WHERE launch_id = ? AND kind = ?",
  ).bind(launchId, "gsc").first<{ id: string }>();
  if (existing) {
    await c.env.DB.prepare(
      "UPDATE connections SET access_json = ?, site_url = ?, updated_at = ? WHERE id = ?",
    ).bind(access, siteUrl, now, existing.id).run();
  } else {
    await c.env.DB.prepare(
      "INSERT INTO connections (id, user_id, launch_id, kind, access_json, site_url, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    ).bind(randomId(), userId, launchId, "gsc", access, siteUrl, now, now).run();
  }
  try { await syncGsc(c.env, launch); } catch (err) { console.error("gsc sync after connect failed", err); }
  return c.redirect("/app?connected=gsc");
}

async function pickGscProperty(accessToken: string, launchSite: string | null): Promise<string | null> {
  if (!accessToken) return null;
  const res = await fetch("https://www.googleapis.com/webmasters/v3/sites", {
    headers: { authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) return null;
  const data = await res.json() as { siteEntry?: Array<{ siteUrl?: string }> };
  const host = hostnameOf(launchSite || "");
  const entries = data.siteEntry ?? [];
  const match = entries.find((e) => e.siteUrl && hostMatches(host, e.siteUrl));
  return match?.siteUrl ?? null;
}

async function refreshGscAccess(env: Env, refreshToken: string): Promise<{ access_token: string; refresh_token: string } | null> {
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: env.GOOGLE_CLIENT_ID!,
      client_secret: env.GOOGLE_CLIENT_SECRET!,
      refresh_token: refreshToken,
      grant_type: "refresh_token",
    }),
  });
  const data = await res.json() as { access_token?: string; refresh_token?: string };
  if (!data.access_token) return null;
  return { access_token: data.access_token, refresh_token: data.refresh_token || refreshToken };
}

async function upsertQuery(
  db: D1Database,
  launchId: string,
  engine: string,
  query: string,
  page: string,
  clicks: number,
  impressions: number,
  ctr: number,
  position: number,
  day: string,
) {
  const q = query.slice(0, 240);
  const p = (page || "").slice(0, 500);
  await db.prepare(
    `INSERT INTO search_queries (launch_id, engine, query, page, clicks, impressions, ctr, position, day)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(launch_id, engine, query, page, day) DO UPDATE SET
       clicks = excluded.clicks,
       impressions = excluded.impressions,
       ctr = excluded.ctr,
       position = excluded.position`,
  ).bind(launchId, engine, q, p, clicks, impressions, ctr, position, day).run();
}

export async function syncGsc(env: Env, launch: LaunchRow): Promise<void> {
  if (!gscOAuthConfigured(env)) return;
  const conn = await env.DB.prepare(
    "SELECT id, user_id, launch_id, kind, access_json, site_url FROM connections WHERE launch_id = ? AND kind = ?",
  ).bind(launch.id, "gsc").first<ConnectionRow>();
  if (!conn?.access_json) return;
  let access: { refresh_token?: string };
  try { access = JSON.parse(conn.access_json) as { refresh_token?: string }; } catch { return; }
  if (!access.refresh_token) return;
  const tokens = await refreshGscAccess(env, access.refresh_token);
  if (!tokens) return;
  if (tokens.refresh_token !== access.refresh_token) {
    await env.DB.prepare("UPDATE connections SET access_json = ?, updated_at = ? WHERE id = ?")
      .bind(JSON.stringify({ refresh_token: tokens.refresh_token }), Date.now(), conn.id).run();
  }
  let siteUrl = conn.site_url;
  if (!siteUrl || launch.site_url) {
    const picked = await pickGscProperty(tokens.access_token, launch.site_url);
    if (picked && picked !== siteUrl) {
      siteUrl = picked;
      await env.DB.prepare("UPDATE connections SET site_url = ?, updated_at = ? WHERE id = ?")
        .bind(siteUrl, Date.now(), conn.id).run();
    }
  }
  if (!siteUrl) return;
  const end = new Date();
  end.setUTCDate(end.getUTCDate() - 1);
  const start = new Date(end);
  start.setUTCDate(start.getUTCDate() - 27);
  const startDate = isoDay(start);
  const endDate = isoDay(end);
  const url = `https://www.googleapis.com/webmasters/v3/sites/${encodeURIComponent(siteUrl)}/searchAnalytics/query`;
  const res = await fetch(url, {
    method: "POST",
    headers: { authorization: `Bearer ${tokens.access_token}`, "content-type": "application/json" },
    body: JSON.stringify({
      startDate,
      endDate,
      dimensions: ["query", "page"],
      rowLimit: 25000,
    }),
  });
  if (!res.ok) {
    console.error("gsc searchAnalytics failed", res.status, await res.text().catch(() => ""));
    return;
  }
  const data = await res.json() as {
    rows?: Array<{ keys?: string[]; clicks?: number; impressions?: number; ctr?: number; position?: number }>;
  };
  for (const row of data.rows ?? []) {
    const query = row.keys?.[0] ?? "";
    const page = row.keys?.[1] ?? "";
    if (!query) continue;
    const clicks = Math.round(row.clicks ?? 0);
    const impressions = Math.round(row.impressions ?? 0);
    await upsertQuery(env.DB, launch.id, "gsc", query, page, clicks, impressions, row.ctr ?? 0, row.position ?? 0, endDate);
  }
}

function bingDay(raw: string | undefined): string {
  if (!raw) return isoDay(new Date());
  const m = /\/Date\((-?\d+)/.exec(raw);
  if (m) return isoDay(new Date(Number(m[1])));
  if (/^\d{4}-\d{2}-\d{2}/.test(raw)) return raw.slice(0, 10);
  return isoDay(new Date());
}

export async function syncBing(_env: Env, launch: LaunchRow, db?: D1Database): Promise<void> {
  const database = db ?? _env.DB;
  const conn = await database.prepare(
    "SELECT id, user_id, launch_id, kind, access_json, site_url FROM connections WHERE launch_id = ? AND kind = ?",
  ).bind(launch.id, "bing").first<ConnectionRow>();
  if (!conn?.access_json) return;
  let access: { api_key?: string };
  try { access = JSON.parse(conn.access_json) as { api_key?: string }; } catch { return; }
  const apiKey = access.api_key?.trim();
  const siteUrl = conn.site_url || launch.site_url;
  if (!apiKey || !siteUrl) return;
  const url = new URL("https://ssl.bing.com/webmaster/api.svc/json/GetQueryStats");
  url.searchParams.set("siteUrl", siteUrl);
  url.searchParams.set("apikey", apiKey);
  const res = await fetch(url.toString(), { headers: { accept: "application/json" } });
  if (!res.ok) {
    console.error("bing GetQueryStats failed", res.status, await res.text().catch(() => ""));
    return;
  }
  const data = await res.json() as {
    d?: Array<{
      Query?: string;
      Clicks?: number;
      Impressions?: number;
      AvgImpressionPosition?: number;
      AvgClickPosition?: number;
      Date?: string;
    }>;
  };
  const cutoff = Date.now() - 28 * 86400000;
  for (const row of data.d ?? []) {
    const query = (row.Query ?? "").trim();
    if (!query) continue;
    const day = bingDay(row.Date);
    const dayTs = Date.parse(day + "T00:00:00Z");
    if (Number.isFinite(dayTs) && dayTs < cutoff) continue;
    const clicks = Math.round(row.Clicks ?? 0);
    const impressions = Math.round(row.Impressions ?? 0);
    const ctr = impressions ? clicks / impressions : 0;
    const position = row.AvgImpressionPosition ?? row.AvgClickPosition ?? 0;
    await upsertQuery(database, launch.id, "bing", query, "", clicks, impressions, ctr, position, day);
  }
}

export async function syncAllSearch(env: Env): Promise<void> {
  const { results } = await env.DB.prepare(
    `SELECT launches.id, launches.name, launches.slug, launches.site_url, launches.manual_revenue_cents, launches.created_at, connections.kind
     FROM connections JOIN launches ON launches.id = connections.launch_id`,
  ).all<LaunchRow & { kind: string }>();
  for (const row of results ?? []) {
    try {
      if (row.kind === "gsc") await syncGsc(env, row);
      else if (row.kind === "bing") await syncBing(env, row);
    } catch (err) {
      console.error("search sync failed", row.id, row.kind, err);
    }
  }
}

export async function listSearchRows(db: D1Database, launchId: string) {
  const { results } = await db.prepare(
    "SELECT engine, query, page, clicks, impressions, ctr, position, day FROM search_queries WHERE launch_id = ? ORDER BY clicks DESC LIMIT 500",
  ).bind(launchId).all();
  return results ?? [];
}

export async function connectionStatus(db: D1Database, launchId: string) {
  const { results } = await db.prepare(
    "SELECT kind, site_url, updated_at FROM connections WHERE launch_id = ?",
  ).bind(launchId).all<{ kind: string; site_url: string | null; updated_at: number }>();
  const gsc = (results ?? []).find((r) => r.kind === "gsc");
  const bing = (results ?? []).find((r) => r.kind === "bing");
  return {
    gsc: { connected: Boolean(gsc), site_url: gsc?.site_url ?? null, updated_at: gsc?.updated_at ?? null },
    bing: { connected: Boolean(bing), site_url: bing?.site_url ?? null, updated_at: bing?.updated_at ?? null },
  };
}

export async function upsertBingConnection(
  db: D1Database,
  userId: string,
  launchId: string,
  apiKey: string,
  siteUrl: string | null,
) {
  const now = Date.now();
  const access = JSON.stringify({ api_key: apiKey });
  const existing = await db.prepare("SELECT id FROM connections WHERE launch_id = ? AND kind = ?")
    .bind(launchId, "bing").first<{ id: string }>();
  if (existing) {
    await db.prepare("UPDATE connections SET access_json = ?, site_url = ?, updated_at = ? WHERE id = ?")
      .bind(access, siteUrl, now, existing.id).run();
  } else {
    await db.prepare(
      "INSERT INTO connections (id, user_id, launch_id, kind, access_json, site_url, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    ).bind(randomId(), userId, launchId, "bing", access, siteUrl, now, now).run();
  }
}

export async function deleteConnection(db: D1Database, launchId: string, kind: string) {
  await db.prepare("DELETE FROM connections WHERE launch_id = ? AND kind = ?").bind(launchId, kind).run();
  await db.prepare("DELETE FROM search_queries WHERE launch_id = ? AND engine = ?").bind(launchId, kind).run();
}
