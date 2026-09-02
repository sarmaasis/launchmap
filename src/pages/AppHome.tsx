import { useEffect, useState } from "react";
import { go } from "../lib/nav";

type Launch = { id: string; name: string; slug: string; site_url: string | null; public_url: string; watermark: boolean; manual_revenue_cents: number };
type Ent = { email: string; plan: string; can_create: boolean; watermark: boolean; launch_credits: number; launch_count: number };

export default function AppHome() {
  const [ent, setEnt] = useState<Ent | null>(null);
  const [launches, setLaunches] = useState<Launch[]>([]);
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [site, setSite] = useState("");
  const [err, setErr] = useState("");
  const [picked, setPicked] = useState<Launch | null>(null);
  const [rev, setRev] = useState("0");

  async function load() {
    const me = await fetch("/api/me");
    if (me.status === 401) { go("/login"); return; }
    const list = await fetch("/api/launches");
    const data = await list.json() as { launches: Launch[]; entitlement: Ent };
    setLaunches(data.launches);
    setEnt(data.entitlement);
    if (data.launches[0]) { setPicked(data.launches[0]); setRev(String((data.launches[0].manual_revenue_cents || 0) / 100)); }
  }
  useEffect(() => { load(); }, []);

  async function create(e: React.FormEvent) {
    e.preventDefault();
    setErr("");
    const res = await fetch("/api/launches", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name, slug, site_url: site }) });
    const data = await res.json() as { error?: string };
    if (!res.ok) { setErr(data.error ?? "Could not create"); return; }
    setName(""); setSlug(""); setSite("");
    await load();
  }

  async function checkout(plan: "monthly" | "one_launch") {
    const res = await fetch("/api/checkout", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ plan, launch_id: picked?.id }) });
    const data = await res.json() as { checkout_url?: string; error?: string };
    if (!res.ok || !data.checkout_url) { setErr(data.error ?? "Checkout is not configured"); return; }
    window.location.href = data.checkout_url;
  }

  async function saveRevenue() {
    if (!picked) return;
    const cents = Math.round(Number(rev) * 100);
    await fetch(`/api/launches/${picked.id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ manual_revenue_cents: cents }) });
    await load();
  }

  const origin = window.location.origin;
  return (
    <div className="wrap">
      <nav className="nav">
        <a className="brand" href="/" onClick={(e) => { e.preventDefault(); go("/"); }}><i /> Launchmap</a>
        <div className="nav-links">
          <span>{ent?.email}</span>
          <button className="btn ghost" onClick={async () => { await fetch("/api/auth/logout", { method: "POST" }); go("/"); }}>Log out</button>
        </div>
      </nav>
      <div className="grid-2">
        <div className="card">
          <h2>New launch</h2>
          <p className="lede">Free accounts get one board. {ent?.can_create ? "You can create another." : "Unlock more with checkout."}</p>
          <form className="form" onSubmit={create}>
            <label>Name</label>
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Acme launch week" required />
            <label>Slug</label>
            <input value={slug} onChange={(e) => setSlug(e.target.value)} placeholder="acme" />
            <label>Site URL</label>
            <input value={site} onChange={(e) => setSite(e.target.value)} placeholder="https://acme.com" />
            <button className="btn" type="submit">Create board</button>
          </form>
          {err ? <p className="err">{err}</p> : null}
        </div>
        <div className="card">
          <h2>Unlock</h2>
          <p className="lede">Plan: {ent?.plan ?? "free"}. Credits: {ent?.launch_credits}. Watermark: {ent?.watermark ? "on" : "off"}.</p>
          <div className="hero-actions">
            <button className="btn" onClick={() => checkout("one_launch")}>Pay $19 for one launch</button>
            <button className="btn teal" onClick={() => checkout("monthly")}>$9/mo unlimited</button>
          </div>
        </div>
      </div>
      <div style={{ height: 18 }} />
      {launches.map((l) => (
        <div className="card" key={l.id} style={{ marginBottom: 12 }}>
          <h3>{l.name}</h3>
          <p><a href={l.public_url} onClick={(e) => { e.preventDefault(); go(`/l/${l.slug}`); }}>{l.public_url}</a></p>
          <p className="lede">Paste this on {l.site_url || "your site"}.</p>
          <pre className="snippet">{`<script src="${origin}/embed.js" data-slug="${l.slug}" async></script>`}</pre>
          <div className="hero-actions" style={{ marginTop: 12 }}>
            <button className="btn ghost" onClick={() => { setPicked(l); setRev(String((l.manual_revenue_cents || 0) / 100)); navigator.clipboard.writeText(`<script src="${origin}/embed.js" data-slug="${l.slug}" async></script>`); }}>Copy snippet</button>
          </div>
        </div>
      ))}
      {picked ? (
        <div className="card">
          <h3>Manual revenue for {picked.name}</h3>
          <p className="lede">If you are not sending Dodo webhooks yet, type the first dollar here. It shows on the public board.</p>
          <div className="hero-actions">
            <input value={rev} onChange={(e) => setRev(e.target.value)} style={{ maxWidth: 160 }} />
            <button className="btn ghost" onClick={saveRevenue}>Save dollars</button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
