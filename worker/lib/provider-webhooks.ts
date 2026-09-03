import { verifyStandardWebhook } from "./standard-webhooks";
import {
  applyRefund,
  asRecord,
  collectMeta,
  hmacBytes,
  insertTrustedPayment,
  num,
  pickVid,
  resolveLaunchId,
  signaturesMatch,
  verifyLemonSignature,
  verifyPaddleSignature,
} from "./payments";

export async function verifyPolarWebhook(
  rawBody: string,
  headers: { id?: string | null; timestamp?: string | null; signature?: string | null; polarSignature?: string | null },
  secret: string,
): Promise<boolean> {
  const sig = headers.signature || headers.polarSignature || "";
  const id = headers.id || "";
  const ts = headers.timestamp || "";
  if (id && ts && sig) {
    try {
      await verifyStandardWebhook({ payload: rawBody, webhookId: id, webhookTimestamp: ts, webhookSignature: sig, secret });
      return true;
    } catch {
      /* fall through to raw HMAC */
    }
  }
  if (!headers.polarSignature && !headers.signature) return false;
  const header = headers.polarSignature || headers.signature || "";
  const got = await hmacBytes(secret, rawBody);
  if (await signaturesMatch(got, header.replace(/^v1[,=]/, "").trim())) return true;
  // Some Polar-Signature values look like Standard Webhooks "v1,<b64>" without id/ts on that header.
  return false;
}

function centsFrom(obj: Record<string, unknown>, keys: string[]): number {
  for (const key of keys) {
    const n = num(obj[key]);
    if (n) return Math.round(n);
  }
  return 0;
}

async function paid(db: D1Database, provider: string, data: Record<string, unknown>, extraMeta?: Record<string, unknown>) {
  const meta = collectMeta(data, extraMeta, asRecord(data.customer));
  const launchId = await resolveLaunchId(db, meta);
  if (!launchId) return;
  const amount = centsFrom(data, ["amount", "total_amount", "net_amount", "total"]);
  const currency = typeof data.currency === "string" ? data.currency : "usd";
  const external = typeof data.id === "string" ? data.id : typeof data.order_id === "string" ? data.order_id : null;
  const kind = (data.subscription_id || data.subscriptionId) ? "subscription" : "one_time";
  await insertTrustedPayment(db, {
    launchId,
    vid: pickVid(meta),
    provider,
    amount_cents: amount,
    kind: typeof kind === "string" ? kind : "one_time",
    currency,
    external_id: external,
  });
}

export async function handlePolarEvent(db: D1Database, event: { type?: string; data?: unknown }): Promise<void> {
  const type = (event.type ?? "").toLowerCase();
  const data = asRecord(event.data);
  if (type === "order.paid" || (type === "checkout.updated" && String(data.status ?? "").toLowerCase() === "succeeded")) {
    await paid(db, "polar", data);
    return;
  }
  if (type === "refund.created" || type === "refund.updated" || type === "order.refunded" || type.includes("refund")) {
    const ids = [typeof data.id === "string" ? data.id : "", typeof data.order_id === "string" ? data.order_id : "", typeof asRecord(data.order).id === "string" ? String(asRecord(data.order).id) : ""].filter(Boolean);
    await applyRefund(db, "polar", ids, centsFrom(data, ["amount", "total_amount", "refunded_amount"]));
  }
}

export async function handlePaddleEvent(db: D1Database, event: { event_type?: string; data?: unknown }): Promise<void> {
  const type = (event.event_type ?? "").toLowerCase();
  const data = asRecord(event.data);
  const details = asRecord(data.details);
  const totals = asRecord(details.totals);
  const custom = asRecord(data.custom_data);
  if (type === "transaction.completed") {
    const payload = {
      ...data,
      amount: num(totals.grand_total ?? totals.total ?? data.grand_total),
      currency: typeof totals.currency_code === "string" ? totals.currency_code : data.currency_code,
      metadata: custom,
    };
    await paid(db, "paddle", payload, custom);
    return;
  }
  if (type === "adjustment.created") {
    const action = String(data.action ?? "").toLowerCase();
    if (action && action !== "refund" && action !== "chargeback") return;
    const adjTotals = asRecord(data.totals);
    const ids = [typeof data.transaction_id === "string" ? data.transaction_id : "", typeof data.id === "string" ? data.id : ""].filter(Boolean);
    await applyRefund(db, "paddle", ids, centsFrom({ ...data, ...adjTotals }, ["grand_total", "total", "earnings", "amount"]));
  }
}

export async function handleLemonEvent(db: D1Database, payload: Record<string, unknown>): Promise<void> {
  const meta = asRecord(payload.meta);
  const name = String(meta.event_name ?? "").toLowerCase();
  const data = asRecord(payload.data);
  const attrs = asRecord(data.attributes);
  const custom = asRecord(meta.custom_data);
  const merged: Record<string, unknown> = { ...attrs, ...data, metadata: custom, id: data.id ?? attrs.identifier };
  if (name === "order_created" || name === "subscription_payment_success") {
    merged.amount = num(attrs.total ?? attrs.subtotal);
    merged.currency = attrs.currency;
    await paid(db, "lemon", merged, custom);
    return;
  }
  if (name === "order_refunded") {
    const ids = [typeof data.id === "string" ? data.id : "", typeof attrs.identifier === "string" ? attrs.identifier : ""].filter(Boolean);
    await applyRefund(db, "lemon", ids, num(attrs.total ?? attrs.refunded));
  }
}

export { verifyLemonSignature, verifyPaddleSignature };
