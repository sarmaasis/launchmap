import { retentionMs } from "./hashday";

export async function purgeExpiredEvents(db: D1Database) {
  const now = Date.now();
  const freeCut = now - retentionMs("free");
  const paidCut = now - retentionMs("monthly");
  const freeFilter = "SELECT launches.id FROM launches JOIN users ON users.id = launches.user_id WHERE users.plan NOT IN ('pro', 'business', 'monthly')";
  const paidFilter = "SELECT launches.id FROM launches JOIN users ON users.id = launches.user_id WHERE users.plan IN ('pro', 'business', 'monthly')";
  for (const [cut, filter] of [[freeCut, freeFilter], [paidCut, paidFilter]] as const) {
    await db.prepare(`DELETE FROM events WHERE created_at < ? AND launch_id IN (${filter})`).bind(cut).run();
    await db.prepare(`DELETE FROM payments WHERE created_at < ? AND launch_id IN (${filter})`).bind(cut).run();
    await db.prepare(`DELETE FROM visitors WHERE last_at < ? AND launch_id IN (${filter})`).bind(cut).run();
    await db.prepare(`DELETE FROM hour_buckets WHERE hour_ts < ? AND launch_id IN (${filter})`).bind(cut).run();
  }
  await db.prepare("DELETE FROM webhook_events WHERE processed_at < ?").bind(now - 1000 * 60 * 60 * 24 * 30).run();
  await db.prepare("DELETE FROM magic_links WHERE expires_at < ?").bind(now - 1000 * 60 * 60 * 24).run();
  await db.prepare("DELETE FROM sessions WHERE expires_at < ?").bind(now).run();
}

export async function eraseUser(db: D1Database, userId: string, email: string) {
  const launches = await db.prepare("SELECT id FROM launches WHERE user_id = ?").bind(userId).all<{ id: string }>();
  for (const row of launches.results ?? []) {
    await db.prepare("DELETE FROM events WHERE launch_id = ?").bind(row.id).run();
    await db.prepare("DELETE FROM visitors WHERE launch_id = ?").bind(row.id).run();
    await db.prepare("DELETE FROM payments WHERE launch_id = ?").bind(row.id).run();
    await db.prepare("DELETE FROM hour_buckets WHERE launch_id = ?").bind(row.id).run();
    await db.prepare("DELETE FROM launch_modes WHERE launch_id = ?").bind(row.id).run();
    await db.prepare("DELETE FROM goals WHERE launch_id = ?").bind(row.id).run();
  }
  await db.prepare("DELETE FROM launches WHERE user_id = ?").bind(userId).run();
  await db.prepare("DELETE FROM sessions WHERE user_id = ?").bind(userId).run();
  await db.prepare("DELETE FROM magic_links WHERE user_id = ?").bind(userId).run();
  await db.prepare("DELETE FROM users WHERE id = ?").bind(userId).run();
  await db.prepare("INSERT INTO deletion_requests (id, user_id, email, requested_at, completed_at, note) VALUES (?, ?, ?, ?, ?, ?)").bind(crypto.randomUUID(), userId, email, Date.now(), Date.now(), "account_erased").run();
}

export async function exportAccount(db: D1Database, userId: string) {
  const user = await db.prepare("SELECT id, email, created_at, plan, plan_status FROM users WHERE id = ?").bind(userId).first();
  const launches = (await db.prepare("SELECT id, name, slug, site_url, created_at FROM launches WHERE user_id = ?").bind(userId).all()).results ?? [];
  const events = (await db.prepare("SELECT events.id, events.kind, events.name, events.vid, events.country, events.city, events.path, events.referrer, events.device, events.utm_source, events.utm_medium, events.utm_campaign, events.amount_cents, events.created_at, events.bot FROM events JOIN launches ON launches.id = events.launch_id WHERE launches.user_id = ? ORDER BY events.created_at DESC LIMIT 20000").bind(userId).all()).results ?? [];
  const visitors = (await db.prepare("SELECT visitors.* FROM visitors JOIN launches ON launches.id = visitors.launch_id WHERE launches.user_id = ? LIMIT 20000").bind(userId).all()).results ?? [];
  const payments = (await db.prepare("SELECT payments.id, payments.launch_id, payments.vid, payments.provider, payments.amount_cents, payments.refunded_cents, payments.kind, payments.currency, payments.created_at FROM payments JOIN launches ON launches.id = payments.launch_id WHERE launches.user_id = ? LIMIT 20000").bind(userId).all()).results ?? [];
  return { exported_at: new Date().toISOString(), controller: "Cairn", user, launches, events, visitors, payments };
}
