import { sha256Hex } from "./crypto";

export function retentionMs(plan: string): number {
  if (plan === "pro" || plan === "business" || plan === "monthly") return 1000 * 60 * 60 * 24 * 365 * 3;
  return 1000 * 60 * 60 * 24 * 14;
}

export async function dayVisitorHash(ip: string, ua: string, secret: string): Promise<string> {
  const day = new Date().toISOString().slice(0, 10);
  return (await sha256Hex(secret + "|" + day + "|" + ip + "|" + ua)).slice(0, 16);
}
