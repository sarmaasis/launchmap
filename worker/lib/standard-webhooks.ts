import { decodeBase64Url, hmacSha256, timingSafeEqual } from "./crypto";

/**
 * Standard Webhooks (https://www.standardwebhooks.com/) signature check.
 * Dodo Payments signs with webhook-id, webhook-timestamp, webhook-signature.
 * Secret is typically `whsec_` + base64 key material.
 */
export async function verifyStandardWebhook(opts: {
  payload: string;
  webhookId: string;
  webhookTimestamp: string;
  webhookSignature: string;
  secret: string;
  toleranceSeconds?: number;
}): Promise<void> {
  const { payload, webhookId, webhookTimestamp, webhookSignature, secret } = opts;
  const tolerance = opts.toleranceSeconds ?? 300;

  if (!webhookId || !webhookTimestamp || !webhookSignature || !secret) {
    throw new Error("Missing webhook verification fields");
  }

  const ts = Number(webhookTimestamp);
  if (!Number.isFinite(ts)) throw new Error("Invalid webhook timestamp");
  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - ts) > tolerance) throw new Error("Webhook timestamp too old");

  const keyBytes = parseWebhookSecret(secret);
  const signed = `${webhookId}.${webhookTimestamp}.${payload}`;
  const expected = new Uint8Array(await hmacSha256(keyBytes, signed));

  const signatures = webhookSignature.split(" ").flatMap((part) => {
    const [, value] = part.split(",", 2);
    const raw = value ?? part;
    try {
      return [decodeBase64Url(raw)];
    } catch {
      return [];
    }
  });

  if (signatures.length === 0) throw new Error("No webhook signatures");

  let ok = false;
  for (const sig of signatures) {
    if (sig.length === expected.length && timingSafeEqual(sig, expected)) ok = true;
  }
  if (!ok) throw new Error("Invalid webhook signature");
}

function parseWebhookSecret(secret: string): Uint8Array {
  const trimmed = secret.trim();
  const raw = trimmed.startsWith("whsec_") ? trimmed.slice("whsec_".length) : trimmed;
  try {
    return decodeBase64Url(raw);
  } catch {
    return new TextEncoder().encode(trimmed);
  }
}
