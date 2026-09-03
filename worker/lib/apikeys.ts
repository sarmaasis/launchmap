import type { Context } from "hono";
import { randomId, sha256Hex } from "./crypto";
import { canCreateLaunch, showWatermark, type UserRow } from "./auth";

export async function hashApiToken(secret: string | undefined, token: string): Promise<string> {
  return sha256Hex(`${secret ?? ""}:${token}`);
}

export async function createApiKey(db: D1Database, secret: string | undefined, userId: string, name: string) {
  const raw = `lm_live_${randomId(24)}`;
  const token_hash = await hashApiToken(secret, raw);
  const prefix = raw.slice(0, 16);
  const id = randomId();
  const created_at = Date.now();
  await db.prepare(
    "INSERT INTO api_keys (id, user_id, name, prefix, token_hash, created_at, last_used_at) VALUES (?, ?, ?, ?, ?, ?, NULL)",
  ).bind(id, userId, name.slice(0, 80), prefix, token_hash, created_at).run();
  return { id, name: name.slice(0, 80), prefix, secret: raw, created_at };
}

export async function listApiKeys(db: D1Database, userId: string) {
  const { results } = await db.prepare(
    "SELECT id, name, prefix, created_at, last_used_at FROM api_keys WHERE user_id = ? ORDER BY created_at DESC",
  ).bind(userId).all();
  return results ?? [];
}

export async function deleteApiKey(db: D1Database, userId: string, id: string): Promise<boolean> {
  const row = await db.prepare("SELECT id FROM api_keys WHERE id = ? AND user_id = ?").bind(id, userId).first();
  if (!row) return false;
  await db.prepare("DELETE FROM api_keys WHERE id = ? AND user_id = ?").bind(id, userId).run();
  return true;
}

export async function getBearerUser(c: Context<{ Bindings: Env }>): Promise<UserRow | null> {
  const header = c.req.header("authorization") || "";
  const m = /^Bearer\s+(\S+)/i.exec(header);
  if (!m) return null;
  const token = m[1];
  const tokenHash = await hashApiToken(c.env.SESSION_SECRET, token);
  const row = await c.env.DB.prepare(
    `SELECT users.id, users.email, users.created_at, users.plan, users.plan_status, users.launch_credits, users.watermark, users.dodo_customer_id, users.dodo_subscription_id, users.dodo_payment_id, api_keys.id as key_id
     FROM api_keys JOIN users ON users.id = api_keys.user_id WHERE api_keys.token_hash = ?`,
  ).bind(tokenHash).first<UserRow & { key_id: string }>();
  if (!row) return null;
  await c.env.DB.prepare("UPDATE api_keys SET last_used_at = ? WHERE id = ?").bind(Date.now(), row.key_id).run();
  return row;
}

export function publicUser(user: UserRow, launchCount: number) {
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
