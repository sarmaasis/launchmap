import { useMemo, useState } from "react";
import { go } from "../lib/nav";

export default function Login() {
  const params = useMemo(() => new URLSearchParams(window.location.search), []);
  const [email, setEmail] = useState("");
  const [msg, setMsg] = useState(params.get("error") ? "That link is missing or expired." : "");
  const [link, setLink] = useState("");
  const [busy, setBusy] = useState(false);
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setMsg("");
    const res = await fetch("/api/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email }) });
    const data = await res.json() as { error?: string; message?: string; verifyUrl?: string };
    setBusy(false);
    if (!res.ok) { setMsg(data.error ?? "Could not send link"); return; }
    setMsg(data.message ?? "Check your inbox.");
    if (data.verifyUrl) setLink(data.verifyUrl);
  }
  return (
    <div className="wrap">
      <nav className="nav"><a className="brand" href="/" onClick={(e) => { e.preventDefault(); go("/"); }}><i /> Launchmap</a></nav>
      <div className="card" style={{ maxWidth: 420, margin: "40px auto" }}>
        <h2>Magic link</h2>
        <p className="lede">No passwords. We email a 15 minute login URL. In dev, if EMAIL is missing, the URL is logged and shown here.</p>
        <form className="form" onSubmit={submit}>
          <label>Work email</label>
          <input type="email" required value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@company.com" />
          <button className="btn" disabled={busy} type="submit">{busy ? "Sending" : "Email me a link"}</button>
        </form>
        {msg ? <p className="ok">{msg}</p> : null}
        {link ? <p><a href={link}>Open login link</a></p> : null}
      </div>
    </div>
  );
}
