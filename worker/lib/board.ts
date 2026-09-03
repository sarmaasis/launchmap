import { hourFloor } from "./payments";

export type LaunchRow = { id: string; name: string; slug: string; site_url: string | null; manual_revenue_cents: number; created_at: number };

const AI_NAMES = new Set(["ChatGPT", "Perplexity", "Claude", "Gemini"]);

type SourceRow = { name: string; visitors: number; revenue_cents: number };
type HourRow = { hour_ts: number; views: number; uniques: number; signups: number; revenue_cents: number };
type Hit = {
  id: string; kind: string; name?: string | null; vid?: string | null; country: string | null; city: string | null;
  lat: number | null; lng: number | null; path: string | null; amount_cents: number; created_at: number;
  referrer?: string | null; unverified?: boolean;
};

function splitSources(rows: SourceRow[]) {
  const sources = rows.filter((s) => !AI_NAMES.has(s.name));
  const ai = rows.filter((s) => AI_NAMES.has(s.name));
  return { sources, ai };
}

async function sourceTable(db: D1Database, launchId: string, since: number, touch: "first" | "last"): Promise<SourceRow[]> {
  const col = touch === "last" ? "last_referrer" : "first_referrer";
  const grouped = (await db.prepare(
    `SELECT COALESCE(v.${col}, 'Direct') as name,
            COUNT(*) as visitors,
            COALESCE(SUM(p.net), 0) as revenue_cents
     FROM visitors v
     LEFT JOIN (
       SELECT vid, SUM(amount_cents - refunded_cents) as net
       FROM payments
       WHERE launch_id = ? AND vid IS NOT NULL AND created_at >= ?
       GROUP BY vid
     ) p ON p.vid = v.id
     WHERE v.launch_id = ? AND v.last_at >= ?
     GROUP BY COALESCE(v.${col}, 'Direct')
     ORDER BY visitors DESC
     LIMIT 12`,
  ).bind(launchId, since, launchId, since).all<SourceRow>()).results ?? [];
  const unattr = await db.prepare(
    `SELECT COALESCE(SUM(amount_cents - refunded_cents), 0) as n FROM payments
     WHERE launch_id = ? AND created_at >= ? AND (vid IS NULL OR vid = '')`,
  ).bind(launchId, since).first<{ n: number }>();
  const extra = unattr?.n ?? 0;
  if (extra > 0) grouped.push({ name: "Unattributed", visitors: 0, revenue_cents: extra });
  return grouped;
}

function fillSeries(since: number, rows: HourRow[]): HourRow[] {
  const start = hourFloor(since);
  const end = hourFloor(Date.now());
  const map = new Map(rows.map((r) => [r.hour_ts, r]));
  const out: HourRow[] = [];
  for (let t = start; t <= end; t += 3_600_000) {
    out.push(map.get(t) ?? { hour_ts: t, views: 0, uniques: 0, signups: 0, revenue_cents: 0 });
  }
  return out;
}

export async function loadBoard(db: D1Database, launch: LaunchRow, since = 0, touch: "first" | "last" = "first") {
  const id = launch.id;
  const views = await db.prepare(
    "SELECT COUNT(*) as n FROM events WHERE launch_id = ? AND bot = 0 AND created_at >= ? AND kind = ?",
  ).bind(id, since, "pageview").first<{ n: number }>();
  const uniques = await db.prepare(
    `SELECT COUNT(DISTINCT COALESCE(NULLIF(vid, ''), visitor_hash)) as n
     FROM events WHERE launch_id = ? AND bot = 0 AND created_at >= ? AND kind = ?`,
  ).bind(id, since, "pageview").first<{ n: number }>();
  const signups = await db.prepare(
    "SELECT COUNT(*) as n FROM events WHERE launch_id = ? AND bot = 0 AND created_at >= ? AND kind = ?",
  ).bind(id, since, "signup").first<{ n: number }>();
  const paid = await db.prepare(
    "SELECT COALESCE(SUM(amount_cents - refunded_cents), 0) as n FROM payments WHERE launch_id = ? AND created_at >= ?",
  ).bind(id, since).first<{ n: number }>();
  const customers = await db.prepare(
    "SELECT COUNT(DISTINCT vid) as n FROM payments WHERE launch_id = ? AND created_at >= ? AND vid IS NOT NULL AND refunded_cents < amount_cents",
  ).bind(id, since).first<{ n: number }>();
  const eventHits = (await db.prepare(
    `SELECT id, kind, name, vid, country, city, lat, lng, path, amount_cents, created_at, referrer
     FROM events WHERE launch_id = ? AND bot = 0 AND created_at >= ?
     ORDER BY created_at DESC LIMIT 50`,
  ).bind(id, since).all<Hit>()).results ?? [];
  const payHits = (await db.prepare(
    `SELECT id, 'payment' as kind, kind as name, vid, NULL as country, NULL as city, NULL as lat, NULL as lng,
            first_path as path, (amount_cents - refunded_cents) as amount_cents, created_at, first_referrer as referrer
     FROM payments WHERE launch_id = ? AND created_at >= ?
     ORDER BY created_at DESC LIMIT 20`,
  ).bind(id, since).all<Hit>()).results ?? [];
  const verifiedVids = new Set(payHits.filter((p) => p.vid).map((p) => p.vid as string));
  const payIds = new Set(payHits.map((p) => p.id));
  const merged: Hit[] = [...eventHits];
  for (const p of payHits) {
    if (!merged.some((e) => e.kind === "payment" && e.vid && e.vid === p.vid && Math.abs(e.created_at - p.created_at) < 600_000)) {
      merged.push({ ...p, unverified: false });
    }
  }
  merged.sort((a, b) => b.created_at - a.created_at);
  const visitors = merged.slice(0, 50).map((h) => ({
    ...h,
    unverified: h.kind === "payment" && !(h.vid && verifiedVids.has(h.vid)) && !payIds.has(h.id),
  }));
  const pages = (await db.prepare(
    "SELECT path, COUNT(*) as views FROM events WHERE launch_id = ? AND bot = 0 AND created_at >= ? AND kind = 'pageview' GROUP BY path ORDER BY views DESC LIMIT 8",
  ).bind(id, since).all<{ path: string; views: number }>()).results ?? [];
  const countries = (await db.prepare(
    `SELECT country, COUNT(DISTINCT COALESCE(NULLIF(vid, ''), visitor_hash)) as visitors
     FROM events WHERE launch_id = ? AND bot = 0 AND created_at >= ? AND country IS NOT NULL
     GROUP BY country ORDER BY visitors DESC LIMIT 8`,
  ).bind(id, since).all<{ country: string; visitors: number }>()).results ?? [];
  const sourcesFirst = await sourceTable(db, id, since, "first");
  const sourcesLast = await sourceTable(db, id, since, "last");
  const primary = touch === "last" ? sourcesLast : sourcesFirst;
  const { sources, ai } = splitSources(primary);
  const hourRows = (await db.prepare(
    "SELECT hour_ts, views, uniques, signups, revenue_cents FROM hour_buckets WHERE launch_id = ? AND hour_ts >= ? ORDER BY hour_ts ASC",
  ).bind(id, hourFloor(since)).all<HourRow>()).results ?? [];
  const series = fillSeries(since, hourRows);
  const land = await db.prepare(
    `SELECT COUNT(*) as n FROM visitors WHERE launch_id = ? AND last_at >= ?`,
  ).bind(id, since).first<{ n: number }>();
  const pricing = await db.prepare(
    `SELECT COUNT(DISTINCT vid) as n FROM events
     WHERE launch_id = ? AND bot = 0 AND created_at >= ? AND vid IS NOT NULL AND path LIKE '%pricing%'`,
  ).bind(id, since).first<{ n: number }>();
  const checkout = await db.prepare(
    `SELECT COUNT(DISTINCT vid) as n FROM events
     WHERE launch_id = ? AND bot = 0 AND created_at >= ? AND vid IS NOT NULL
       AND (path LIKE '%checkout%' OR name LIKE '%checkout%' OR name = 'checkout')`,
  ).bind(id, since).first<{ n: number }>();
  const paidStep = await db.prepare(
    `SELECT COUNT(DISTINCT vid) as n FROM payments
     WHERE launch_id = ? AND created_at >= ? AND vid IS NOT NULL AND refunded_cents < amount_cents`,
  ).bind(id, since).first<{ n: number }>();
  const uniqueN = uniques?.n ?? 0;
  const revenue = (launch.manual_revenue_cents ?? 0) + (paid?.n ?? 0);
  const mode = await db.prepare("SELECT live, started_at, ended_at FROM launch_modes WHERE launch_id = ?").bind(id).first<{ live: number; started_at: number | null; ended_at: number | null }>();
  return {
    launch: { name: launch.name, slug: launch.slug, site_url: launch.site_url },
    stats: {
      views: views?.n ?? 0,
      unique: uniqueN,
      signups: signups?.n ?? 0,
      revenue_cents: revenue,
      customers: customers?.n ?? 0,
      rpv: uniqueN ? revenue / uniqueN : 0,
    },
    visitors,
    sources,
    sources_last: splitSources(sourcesLast).sources,
    pages,
    countries,
    ai,
    search: [] as { query: string; clicks: number }[],
    series,
    funnel: [
      { name: "Land", count: land?.n ?? 0 },
      { name: "Pricing", count: pricing?.n ?? 0 },
      { name: "Checkout", count: checkout?.n ?? 0 },
      { name: "Paid", count: paidStep?.n ?? 0 },
    ],
    touch,
    live: mode ? mode.live === 1 : true,
    launch_mode: mode ? { live: mode.live === 1, started_at: mode.started_at, ended_at: mode.ended_at } : { live: true, started_at: null, ended_at: null },
  };
}

export async function loadJourney(db: D1Database, launchId: string, vid: string) {
  const visitor = await db.prepare("SELECT * FROM visitors WHERE launch_id = ? AND id = ?").bind(launchId, vid).first();
  const events = (await db.prepare(
    "SELECT id, kind, name, path, referrer, amount_cents, created_at FROM events WHERE launch_id = ? AND vid = ? ORDER BY created_at ASC LIMIT 200",
  ).bind(launchId, vid).all()).results ?? [];
  const payments = (await db.prepare(
    "SELECT id, provider, amount_cents, refunded_cents, kind, currency, created_at, first_referrer, last_referrer, first_path FROM payments WHERE launch_id = ? AND vid = ? ORDER BY created_at ASC",
  ).bind(launchId, vid).all()).results ?? [];
  return { vid, visitor, events, payments };
}
