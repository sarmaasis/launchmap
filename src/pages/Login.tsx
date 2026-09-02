import { useEffect, useMemo, useState } from "react";
import { go } from "../lib/nav";

type Providers = { google: boolean; github: boolean; magic: boolean };

export default function Login() {
  const params = useMemo(() => new URLSearchParams(window.location.search), []);
  const errors: Record<string, string> = {
    missing_token: "That login link is missing.",
    invalid_or_expired: "That login link expired. Request a new one.",
    oauth_state: "Sign-in was interrupted. Try again.",
    oauth_failed: "Google or GitHub did not complete. Try again.",
    oauth_email: "We need a verified email from that account.",
    oauth_not_configured: "OAuth is not configured on this instance yet. Use email.",
  };
  const [email, setEmail] = useState("");
  const [msg, setMsg] = useState(errors[params.get("error") ?? ""] ?? "");
  const [link, setLink] = useState("");
  const [busy, setBusy] = useState(false);
  const [providers, setProviders] = useState<Providers>({ google: false, github: false, magic: true });

  useEffect(() => {
    fetch("/api/auth/providers")
      .then((r) => r.json())
      .then((d) => setProviders(d as Providers))
      .catch(() => undefined);
  }, []);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setMsg("");
    const res = await fetch("/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email }),
    });
    const data = await res.json() as { error?: string; message?: string; verifyUrl?: string };
    setBusy(false);
    if (!res.ok) { setMsg(data.error ?? "Could not send link"); return; }
    setMsg(data.message ?? "Check your inbox.");
    if (data.verifyUrl) setLink(data.verifyUrl);
  }

  return (
    <div className="auth-page">
      <aside className="auth-brand">
        <a className="brand light" href="/" onClick={(e) => { e.preventDefault(); go("/"); }}><i /> Cairn</a>
        <blockquote>
          <p>Mark the visit that paid.</p>
          <cite>One script. Google or GitHub to start. Fourteen days, no card.</cite>
        </blockquote>
      </aside>
      <main className="auth-panel">
        <h1>Sign in</h1>
        <p className="lede">Start with the account you already have. Email is the fallback.</p>
        <div className="oauth-stack">
          <a className={"oauth-btn google" + (providers.google ? "" : " off")} href={providers.google ? "/api/auth/google" : undefined} onClick={(e) => { if (!providers.google) e.preventDefault(); }} aria-disabled={!providers.google}>
            Continue with Google
          </a>
          <a className={"oauth-btn github" + (providers.github ? "" : " off")} href={providers.github ? "/api/auth/github" : undefined} onClick={(e) => { if (!providers.github) e.preventDefault(); }} aria-disabled={!providers.github}>
            Continue with GitHub
          </a>
          {!providers.google && !providers.github ? (
            <p className="fine">Google and GitHub light up once client IDs are in the Worker secrets.</p>
          ) : null}
        </div>
        <div className="or">or email a 15-minute link</div>
        <form className="form" onSubmit={submit}>
          <label htmlFor="email">Work email</label>
          <input id="email" type="email" required value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@company.com" autoComplete="email" />
          <button className="btn" disabled={busy} type="submit">{busy ? "Sending" : "Email me a link"}</button>
        </form>
        {msg ? <p className="ok">{msg}</p> : null}
        {link ? <p><a className="text-link" href={link}>Open login link</a></p> : null}
      </main>
    </div>
  );
}
