import { randomId, timingSafeEqual } from "./crypto";

export function hourFloor(ts: number): number {
  return Math.floor(ts / 3_600_000) * 3_600_000;
}

export async function bumpHour(
  db: D1Database,
  launchId: string,
  hourTs: number,
  delta: { views?: number; uniques?: number; signups?: number; revenue_cents?: number },
) {
  const views = delta.views ?? 0;
  const uniques = delta.uniques ?? 0;
  const signups = delta.signups ?? 0;
  const revenue = delta.revenue_cents ?? 0;
  await db.prepare(
    `INSERT INTO hour_buckets (launch_id, hour_ts, views, uniques, signups, revenue_cents)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(launch_id, hour_ts) DO UPDATE SET
       views = views + excluded.views,
       uniques = uniques + excluded.uniques,
       signups = signups + excluded.signups,
       revenue_cents = MAX(0, revenue_cents + excluded.revenue_cents)`,
  ).bind(launchId, hourTs, views, uniques, signups, revenue).run();
}

export async function resolveLaunchId(
  db: D1Database,
  meta: { launch_id?: unknown; slug?: unknown; launch_slug?: unknown },
): Promise<string | null> {
  const id = typeof meta.launch_id === "string" ? meta.launch_id.trim() : "";
  if (id) {
    const row = await db.prepare("SELECT id FROM launches WHERE id = ?").bind(id).first<{ id: string }>();
    if (row) return row.id;
  }
  const slug = (typeof meta.slug === "string" ? meta.slug : typeof meta.launch_slug === "string" ? meta.launch_slug : "").trim();
  if (!slug) return null;
  const row = await db.prepare("SELECT id FROM launches WHERE slug = ?").bind(slug).first<{ id: string }>();
  return row?.id ?? null;
}

export function pickVid(meta: Record<string, unknown>, extra?: string | null): string | null {
  const raw = meta.cairn_vid ?? meta.vid ?? extra;
  if (typeof raw !== "string") return null;
  const v = raw.trim();
  return v.length >= 8 ? v.slice(0, 64) : null;
}

type Touch = { first_referrer: string | null; last_referrer: string | null; first_path: string | null };

async function visitorTouch(db: D1Database, launchId: string, vid: string | null): Promise<Touch> {
  if (!vid) return { first_referrer: null, last_referrer: null, first_path: null };
  const row = await db.prepare(
    "SELECT first_referrer, last_referrer, first_path FROM visitors WHERE launch_id = ? AND id = ?",
  ).bind(launchId, vid).first<Touch>();
  return row ?? { first_referrer: null, last_referrer: null, first_path: null };
}

export async function insertTrustedPayment(db: D1Database, input: {
  launchId: string;
  vid: string | null;
  provider: string;
  amount_cents: number;
  kind?: string;
  currency?: string;
  external_id?: string | null;
  created_at?: number;
}): Promise<{ id: string; duplicate: boolean }> {
  const now = input.created_at ?? Date.now();
  const amount = Math.max(0, Math.round(input.amount_cents));
  const kind = input.kind ?? "one_time";
  const currency = (input.currency || "usd").toLowerCase().slice(0, 8);
  const external = input.external_id || null;
  if (external) {
    const existing = await db.prepare(
      "SELECT id FROM payments WHERE provider = ? AND external_id = ?",
    ).bind(input.provider, external).first<{ id: string }>();
    if (existing) return { id: existing.id, duplicate: true };
  }
  const touch = await visitorTouch(db, input.launchId, input.vid);
  const id = randomId();
  try {
    await db.prepare(
      `INSERT INTO payments (id, launch_id, vid, provider, amount_cents, refunded_cents, kind, currency, first_referrer, last_referrer, first_path, created_at, external_id)
       VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      id, input.launchId, input.vid, input.provider, amount, kind, currency,
      touch.first_referrer, touch.last_referrer, touch.first_path, now, external,
    ).run();
  } catch {
    return { id, duplicate: true };
  }
  if (amount > 0) {
    await bumpHour(db, input.launchId, hourFloor(now), { revenue_cents: amount });
  }
  await db.prepare(
    "INSERT INTO events (id, launch_id, kind, visitor_hash, country, city, lat, lng, path, amount_cents, created_at, referrer, vid, name) VALUES (?, ?, ?, NULL, NULL, NULL, NULL, NULL, ?, ?, ?, ?, ?, ?)",
  ).bind(randomId(), input.launchId, "payment", touch.first_path || "/checkout", amount, now, touch.first_referrer, input.vid, "payment").run();
  return { id, duplicate: false };
}

export async function applyRefund(db: D1Database, provider: string, externalIds: string[], refundedCents: number) {
  const amount = Math.max(0, Math.round(refundedCents));
  if (!amount || !externalIds.length) return;
  for (const ext of externalIds) {
    if (!ext) continue;
    const row = await db.prepare(
      "SELECT id, launch_id, amount_cents, refunded_cents, created_at FROM payments WHERE provider = ? AND external_id = ?",
    ).bind(provider, ext).first<{ id: string; launch_id: string; amount_cents: number; refunded_cents: number; created_at: number }>();
    if (!row) continue;
    const next = Math.min(row.amount_cents, amount);
    const delta = next - (row.refunded_cents || 0);
    await db.prepare("UPDATE payments SET refunded_cents = ?, kind = CASE WHEN ? >= amount_cents THEN 'refund' ELSE kind END WHERE id = ?").bind(next, next, row.id).run();
    if (delta > 0) {
      await bumpHour(db, row.launch_id, hourFloor(row.created_at), { revenue_cents: -delta });
    }
    return;
  }
}

function hexToBytes(hex: string): Uint8Array {
  const clean = hex.trim().toLowerCase();
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export async function verifyStripeSignature(rawBody: string, header: string | null | undefined, secret: string): Promise<boolean> {
  if (!header) return false;
  const parts: Record<string, string[]> = {};
  for (const piece of header.split(",")) {
    const eq = piece.indexOf("=");
    if (eq < 0) continue;
    const k = piece.slice(0, eq).trim();
    const v = piece.slice(eq + 1).trim();
    (parts[k] ||= []).push(v);
  }
  const t = parts.t?.[0];
  const v1 = parts.v1 ?? [];
  if (!t || !v1.length) return false;
  const age = Math.abs(Date.now() / 1000 - Number(t));
  if (!Number.isFinite(Number(t)) || age > 60 * 5) return false;
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${t}.${rawBody}`));
  const got = new Uint8Array(mac);
  for (const candidate of v1) {
    const want = hexToBytes(candidate);
    if (want.length === got.length && timingSafeEqual(got, want)) return true;
  }
  return false;
}

export function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? value as Record<string, unknown> : {};
}

export function num(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : typeof value === "string" ? Number(value) || 0 : 0;
}
