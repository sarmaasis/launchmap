import type { Context } from "hono";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import { randomId, randomToken, sha256Hex } from "./crypto";

export const SESSION_COOKIE = "lm_session";
const SESSION_TTL_SECONDS = 60 * 60 * 24 * 30;
const MAGIC_TTL_MS = 15 * 60 * 1000;

export type UserRow = {
  id: string;
  email: string;
  created_at: number;
  plan: string;
  plan_status: string | null;
  launch_credits: number;
  watermark: number;
  dodo_customer_id: string | null;
  dodo_subscription_id: string | null;
  dodo_payment_id: string | null;
};

const USER_COLS =
  "id, email, created_at, plan, plan_status, launch_credits, watermark, dodo_customer_id, dodo_subscription_id, dodo_payment_id";

async function hashToken(secret: string | undefined, token: string): Promise<string> {
  return sha256Hex(`${secret ?? ""}:${token}`);
}

export function canCreateLaunch(user: UserRow, existingCount: number): boolean {
  if (user.plan === "monthly" && (user.plan_status === "active" || !user.plan_status)) return true;
  return existingCount < user.launch_credits;
}

export function showWatermark(user: Pick<UserRow, "plan" | "watermark">): boolean {
  if (user.plan === "monthly") return false;
  return user.watermark !== 0;
}

export async function findOrCreateUser(db: D1Database, email: string): Promise<UserRow> {
  const normalized = email.trim().toLowerCase();
  const existing = await db.prepare(`SELECT ${USER_COLS} FROM users WHERE email = ?`).bind(normalized).first<UserRow>();
  if (existing) return existing;
  const user: UserRow = {
    id: randomId(),
    email: normalized,
    created_at: Date.now(),
    plan: "free",
    plan_status: null,
    launch_credits: 1,
    watermark: 1,
    dodo_customer_id: null,
    dodo_subscription_id: null,
    dodo_payment_id: null,
  };
  await db.prepare(
    `INSERT INTO users (${USER_COLS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(user.id, user.email, user.created_at, user.plan, null, 1, 1, null, null, null).run();
  return user;
}

export async function createMagicLink(db: D1Database, secret: string | undefined, userId: string): Promise<string> {
  const token = randomToken();
  const tokenHash = await hashToken(secret, token);
  await db.prepare(
    "INSERT INTO magic_links (id, user_id, token_hash, expires_at, used_at, created_at) VALUES (?, ?, ?, ?, NULL, ?)",
  ).bind(randomId(), userId, tokenHash, Date.now() + MAGIC_TTL_MS, Date.now()).run();
  return token;
}

export async function consumeMagicLink(db: D1Database, secret: string | undefined, token: string): Promise<UserRow | null> {
  const tokenHash = await hashToken(secret, token);
  const row = await db.prepare(
    `SELECT magic_links.id as link_id, magic_links.expires_at, magic_links.used_at, users.id, users.email, users.created_at, users.plan, users.plan_status, users.launch_credits, users.watermark, users.dodo_customer_id, users.dodo_subscription_id, users.dodo_payment_id FROM magic_links JOIN users ON users.id = magic_links.user_id WHERE magic_links.token_hash = ?`,
  ).bind(tokenHash).first<UserRow & { link_id: string; expires_at: number; used_at: number | null }>();
  if (!row || row.used_at || row.expires_at < Date.now()) return null;
  await db.prepare("UPDATE magic_links SET used_at = ? WHERE id = ?").bind(Date.now(), row.link_id).run();
  return row;
}

export async function createSession(c: Context<{ Bindings: Env }>, userId: string): Promise<void> {
  const token = randomToken();
  const tokenHash = await hashToken(c.env.SESSION_SECRET, token);
  await c.env.DB.prepare(
    "INSERT INTO sessions (id, user_id, token_hash, expires_at, created_at) VALUES (?, ?, ?, ?, ?)",
  ).bind(randomId(), userId, tokenHash, Date.now() + SESSION_TTL_SECONDS * 1000, Date.now()).run();
  setCookie(c, SESSION_COOKIE, token, { httpOnly: true, secure: isSecureRequest(c), sameSite: "Lax", path: "/", maxAge: SESSION_TTL_SECONDS });
}

export async function getSessionUser(c: Context<{ Bindings: Env }>): Promise<UserRow | null> {
  const token = getCookie(c, SESSION_COOKIE);
  if (!token) return null;
  const tokenHash = await hashToken(c.env.SESSION_SECRET, token);
  const row = await c.env.DB.prepare(
    `SELECT users.id, users.email, users.created_at, users.plan, users.plan_status, users.launch_credits, users.watermark, users.dodo_customer_id, users.dodo_subscription_id, users.dodo_payment_id, sessions.expires_at FROM sessions JOIN users ON users.id = sessions.user_id WHERE sessions.token_hash = ?`,
  ).bind(tokenHash).first<UserRow & { expires_at: number }>();
  if (!row || row.expires_at < Date.now()) return null;
  return row;
}

export async function destroySession(c: Context<{ Bindings: Env }>): Promise<void> {
  const token = getCookie(c, SESSION_COOKIE);
  if (token) {
    const tokenHash = await hashToken(c.env.SESSION_SECRET, token);
    await c.env.DB.prepare("DELETE FROM sessions WHERE token_hash = ?").bind(tokenHash).run();
  }
  deleteCookie(c, SESSION_COOKIE, { path: "/" });
}

function isSecureRequest(c: Context): boolean {
  const proto = c.req.header("x-forwarded-proto");
  if (proto) return proto === "https";
  return new URL(c.req.url).protocol === "https:";
}
