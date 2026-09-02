import type { Context } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { createSession, findOrCreateUser } from "./auth";
import { randomToken } from "./crypto";

const STATE_COOKIE = "oauth_state";
const PROVIDER_COOKIE = "oauth_provider";
const STATE_TTL = 60 * 10;

export type OAuthProvider = "google" | "github";

export function oauthConfigured(env: Env, provider: OAuthProvider): boolean {
  if (provider === "google") return Boolean(env.GOOGLE_CLIENT_ID! && env.GOOGLE_CLIENT_SECRET!);
  return Boolean(env.GITHUB_CLIENT_ID! && env.GITHUB_CLIENT_SECRET!);
}

export function startOAuth(c: Context<{ Bindings: Env }>, provider: OAuthProvider, origin: string): Response {
  if (!oauthConfigured(c.env, provider)) {
    return c.redirect("/login?error=oauth_not_configured");
  }
  const state = randomToken(24);
  const secure = isSecure(c);
  setCookie(c, STATE_COOKIE, state, { httpOnly: true, secure, sameSite: "Lax", path: "/", maxAge: STATE_TTL });
  setCookie(c, PROVIDER_COOKIE, provider, { httpOnly: true, secure, sameSite: "Lax", path: "/", maxAge: STATE_TTL });
  const redirectUri = `${origin}/api/auth/${provider}/callback`;
  if (provider === "google") {
    const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
    url.searchParams.set("client_id", c.env.GOOGLE_CLIENT_ID!);
    url.searchParams.set("redirect_uri", redirectUri);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("scope", "openid email profile");
    url.searchParams.set("state", state);
    url.searchParams.set("prompt", "select_account");
    return c.redirect(url.toString());
  }
  const url = new URL("https://github.com/login/oauth/authorize");
  url.searchParams.set("client_id", c.env.GITHUB_CLIENT_ID!);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("scope", "user:email");
  url.searchParams.set("state", state);
  return c.redirect(url.toString());
}

export async function finishOAuth(
  c: Context<{ Bindings: Env }>,
  provider: OAuthProvider,
  origin: string,
): Promise<Response> {
  const code = c.req.query("code");
  const state = c.req.query("state");
  const saved = getCookie(c, STATE_COOKIE);
  const savedProvider = getCookie(c, PROVIDER_COOKIE);
  deleteCookie(c, STATE_COOKIE, { path: "/" });
  deleteCookie(c, PROVIDER_COOKIE, { path: "/" });
  if (!code || !state || !saved || state !== saved || savedProvider !== provider) {
    return c.redirect("/login?error=oauth_state");
  }
  if (!oauthConfigured(c.env, provider)) return c.redirect("/login?error=oauth_not_configured");
  try {
    const email = provider === "google"
      ? await googleEmail(c.env, code, `${origin}/api/auth/google/callback`)
      : await githubEmail(c.env, code, `${origin}/api/auth/github/callback`);
    if (!email) return c.redirect("/login?error=oauth_email");
    const user = await findOrCreateUser(c.env.DB, email);
    await createSession(c, user.id);
    return c.redirect("/app");
  } catch {
    return c.redirect("/login?error=oauth_failed");
  }
}

async function googleEmail(env: Env, code: string, redirectUri: string): Promise<string | null> {
  const body = new URLSearchParams({
    code,
    client_id: env.GOOGLE_CLIENT_ID!,
    client_secret: env.GOOGLE_CLIENT_SECRET!,
    redirect_uri: redirectUri,
    grant_type: "authorization_code",
  });
  const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });
  const token = await tokenRes.json() as { access_token?: string };
  if (!token.access_token) return null;
  const infoRes = await fetch("https://openidconnect.googleapis.com/v1/userinfo", {
    headers: { authorization: `Bearer ${token.access_token}` },
  });
  const info = await infoRes.json() as { email?: string; email_verified?: boolean };
  if (!info.email || info.email_verified === false) return null;
  return info.email.toLowerCase();
}

async function githubEmail(env: Env, code: string, redirectUri: string): Promise<string | null> {
  const tokenRes = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json", "user-agent": "Cairn" },
    body: JSON.stringify({
      client_id: env.GITHUB_CLIENT_ID!,
      client_secret: env.GITHUB_CLIENT_SECRET!,
      code,
      redirect_uri: redirectUri,
    }),
  });
  const token = await tokenRes.json() as { access_token?: string };
  if (!token.access_token) return null;
  const emailsRes = await fetch("https://api.github.com/user/emails", {
    headers: { accept: "application/vnd.github+json", authorization: `Bearer ${token.access_token}`, "user-agent": "Cairn" },
  });
  const emails = await emailsRes.json() as Array<{ email: string; primary: boolean; verified: boolean }>;
  if (!Array.isArray(emails)) return null;
  const primary = emails.find((e) => e.primary && e.verified) ?? emails.find((e) => e.verified);
  return primary?.email.toLowerCase() ?? null;
}

function isSecure(c: Context): boolean {
  const proto = c.req.header("x-forwarded-proto");
  if (proto) return proto === "https";
  return new URL(c.req.url).protocol === "https:";
}
