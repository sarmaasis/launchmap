import { useEffect, useState } from "react";
import { go } from "../lib/nav";
import DataRights from "../ui/DataRights";
import LaunchBoard, { type BoardData } from "../ui/LaunchBoard";

type Launch = { id: string; name: string; slug: string; site_url: string | null; public_url: string; watermark: boolean; manual_revenue_cents: number };
type Ent = { email: string; plan: string; can_create: boolean; watermark: boolean; launch_credits: number; launch_count: number };

export default function AppHome() {
  const [ent, setEnt] = useState<Ent | null>(null);
  const [launches, setLaunches] = useState<Launch[]>([]);
  const [site, setSite] = useState("");
  const [err, setErr] = useState("");
  const [picked, setPicked] = useState<Launch | null>(null);
  const [rev, setRev] = useState("0");
  const [range, setRange] = useState("30d");
  const [touch, setTouch] = useState<"first" | "last">("first");
  const [board, setBoard] = useState<BoardData | null>(null);
  const [copied, setCopied] = useState(false);
  const [panel, setPanel] = useState<"board" | "install" | "plan">("board");
  const [bingKey, setBingKey] = useState("");
  const [conn, setConn] = useState<{ gsc: { connected: boolean; site_url: string | null }; bing: { connected: boolean; site_url: string | null } } | null>(null);
  const [keys, setKeys] = useState<Array<{ id: string; name: string; prefix: string; created_at: number }>>([]);
  const [newKey, setNewKey] = useState<string | null>(null);

  async function load() {
    const me = await fetch("/api/me");
    if (me.status === 401) { go("/login"); return; }
    const list = await fetch("/api/launches");
    const data = await list.json() as { launches: Launch[]; entitlement: Ent };
    setLaunches(data.launches);
    setEnt(data.entitlement);
    const next = data.launches.find((l) => l.id === picked?.id) ?? data.launches[0] ?? null;
    if (next) {
      setPicked(next);
      setRev(String((next.manual_revenue_cents || 0) / 100));
    }
  }

  useEffect(() => { load(); }, []);

  useEffect(() => {
    if (!picked) { setBoard(null); return; }
    let alive = true;
    const tick = async () => {
      const res = await fetch(`/api/launches/${picked.id}/analytics?range=${range}&touch=${touch}`);
      if (!res.ok || !alive) return;
      setBoard(await res.json() as BoardData);
    };
    tick();
    const id = setInterval(tick, 4000);
    return () => { alive = false; clearInterval(id); };
  }, [picked?.id, range, touch]);

  useEffect(() => {
    if (!picked) { setConn(null); return; }
    let alive = true;
    fetch(`/api/launches/${picked.id}/connections`).then(async (res) => {
      if (!res.ok || !alive) return;
      setConn(await res.json());
    });
    return () => { alive = false; };
  }, [picked?.id, panel]);

  useEffect(() => {
    if (panel !== "plan") return;
    fetch("/api/keys").then(async (res) => {
      if (!res.ok) return;
      const data = await res.json() as { keys: Array<{ id: string; name: string; prefix: string; created_at: number }> };
      setKeys(data.keys);
    });
  }, [panel]);

  async function create(e: React.FormEvent) {
    e.preventDefault();
    setErr("");
    let host = site.trim();
    if (host && !/^https?:\/\//.test(host)) host = `https://${host}`;
    let name = host;
    try { name = new URL(host).hostname.replace(/^www\./, ""); } catch { /* keep */ }
    const res = await fetch("/api/launches", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name, slug: name.replace(/\./g, "-"), site_url: host }) });
    const data = await res.json() as { error?: string };
    if (!res.ok) { setErr(data.error ?? "Could not add site"); return; }
    setSite("");
    setPanel("install");
    await load();
  }

  async function checkout(plan: "pro" | "business") {
    const res = await fetch("/api/checkout", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ plan, launch_id: picked?.id }) });
    const data = await res.json() as { checkout_url?: string; error?: string };
    if (!res.ok || !data.checkout_url) { setErr(data.error ?? "Checkout is not configured"); return; }
    window.location.href = data.checkout_url;
  }

  async function saveRevenue() {
    if (!picked) return;
    await fetch(`/api/launches/${picked.id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ manual_revenue_cents: Math.round(Number(rev) * 100) }) });
    await load();
  }

  const origin = window.location.origin;
  const snippet = picked ? `<script src="${origin}/embed.js" data-slug="${picked.slug}" async></script>` : "";

  return (
    <div className="shell">
      <aside className="rail">
        <a className="brand" href="/" onClick={(e) => { e.preventDefault(); go("/"); }}><i /> Cairn</a>
        <p className="rail-kicker">Sites</p>
        <nav className="rail-nav">
          {launches.map((l) => (
            <button key={l.id} className={picked?.id === l.id ? "rail-item on" : "rail-item"} type="button" onClick={() => { setPicked(l); setRev(String((l.manual_revenue_cents || 0) / 100)); setPanel("board"); }}>{l.name}</button>
          ))}
        </nav>
        <div className="rail-foot">
          <button className={panel === "install" ? "rail-item on" : "rail-item"} type="button" onClick={() => setPanel("install")} disabled={!picked}>Install</button>
          <button className={panel === "plan" ? "rail-item on" : "rail-item"} type="button" onClick={() => setPanel("plan")}>Plan</button>
          <p className="rail-email">{ent?.email}</p>
          <button className="btn ghost" type="button" onClick={async () => { await fetch("/api/auth/logout", { method: "POST" }); go("/"); }}>Log out</button>
        </div>
      </aside>
      <main className="work">
        {!launches.length ? (
          <section className="onboard">
            <p className="kicker">Onboarding</p>
            <h1>Add the first website</h1>
            <ol className="steps">
              <li className="done">Signed in as {ent?.email ?? "you"}</li>
              <li className="now">Paste the site URL</li>
              <li>Install the script. Traffic shows here.</li>
            </ol>
            <form className="form onboard-form" onSubmit={create}>
              <label htmlFor="site">Website URL</label>
              <input id="site" value={site} onChange={(e) => setSite(e.target.value)} placeholder="acme.com" required autoFocus />
              <button className="btn" type="submit">Continue</button>
            </form>
            {err ? <p className="err">{err}</p> : null}
          </section>
        ) : panel === "install" && picked ? (
          <section className="onboard">
            <p className="kicker">Install</p>
            <h1>One line in the head</h1>
            <p className="lede">Paste once on {picked.site_url || "your site"}. Call <code>window.cairnSignup()</code> on signup, <code>window.cairnEvent('pricing_click')</code> for custom events, and pass the visitor through checkout with <code>window.cairnCheckoutUrl(url)</code> or <code>data-cairn-checkout</code> on the link. Put that visitor id in checkout metadata as <code>cairn_vid</code> (also accepted: <code>vid</code>, plus <code>launch_id</code> or <code>slug</code>). Client <code>window.cairnPay(cents)</code> shows on the feed as unverified until a webhook joins the same visitor id.</p>
            <pre className="snippet">{snippet}</pre>
            <p className="lede">Webhook URLs for your checkout provider (verify with the matching secret):</p>
            <pre className="snippet">{`${origin}/webhooks/dodo
${origin}/webhooks/stripe
${origin}/webhooks/polar
${origin}/webhooks/paddle
${origin}/webhooks/lemon`}</pre>
            <div className="hero-actions">
              <button className="btn" type="button" onClick={() => { navigator.clipboard.writeText(snippet); setCopied(true); }}> {copied ? "Copied" : "Copy snippet"}</button>
              <button className="btn ghost" type="button" onClick={() => setPanel("board")}>Open dashboard</button>
            </div>
          </section>
        ) : panel === "plan" ? (
          <section className="onboard">
            <p className="kicker">Plan</p>
            <h1>{ent?.plan ?? "free"}</h1>
            <p className="lede">Watermark {ent?.watermark ? "on" : "off"}. {ent?.can_create ? "You can add another site." : "Upgrade to add sites."}</p>
            <form className="form onboard-form" onSubmit={create}>
              <label>Add another website</label>
              <input value={site} onChange={(e) => setSite(e.target.value)} placeholder="another.com" />
              <button className="btn ghost" type="submit">Add site</button>
            </form>
            <div className="hero-actions">
              <button className="btn" type="button" onClick={() => checkout("pro")}>Pro $29/mo</button>
              <button className="btn ghost" type="button" onClick={() => checkout("business")}>Business $79/mo</button>
            </div>
            <p className="lede">Manual revenue (USD) if Dodo is not posting yet.</p>
            <div className="hero-actions">
              <input value={rev} onChange={(e) => setRev(e.target.value)} style={{ maxWidth: 120 }} />
              <button className="btn ghost" type="button" onClick={saveRevenue}>Save</button>
            </div>
            {picked ? (
              <div className="card" style={{ marginTop: 18 }}>
                <h3>Search</h3>
                <p className="lede">Search Console: {conn?.gsc.connected ? `connected${conn.gsc.site_url ? ` (${conn.gsc.site_url})` : ""}` : "not connected"}.</p>
                <p className="lede">Bing: {conn?.bing.connected ? `connected${conn.bing.site_url ? ` (${conn.bing.site_url})` : ""}` : "not connected"}.</p>
                <div className="hero-actions">
                  <button className="btn" type="button" onClick={() => { window.location.href = `/api/connect/gsc?launch_id=${picked.id}`; }}>Connect Search Console</button>
                  {conn?.gsc.connected ? <button className="btn ghost" type="button" onClick={async () => { await fetch(`/api/launches/${picked.id}/connect/gsc`, { method: "DELETE" }); setConn(await (await fetch(`/api/launches/${picked.id}/connections`)).json()); }}>Disconnect GSC</button> : null}
                </div>
                <form className="form onboard-form" onSubmit={async (e) => {
                  e.preventDefault();
                  const res = await fetch(`/api/launches/${picked.id}/connect/bing`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ api_key: bingKey, site_url: picked.site_url }) });
                  const data = await res.json() as { error?: string; connections?: typeof conn };
                  if (!res.ok) { setErr(data.error ?? "Could not save Bing key"); return; }
                  setBingKey("");
                  if (data.connections) setConn(data.connections);
                }}>
                  <label>Bing Webmaster API key</label>
                  <input value={bingKey} onChange={(e) => setBingKey(e.target.value)} placeholder="Bing API key" />
                  <button className="btn ghost" type="submit">Save Bing key</button>
                </form>
                {conn?.bing.connected ? <button className="btn ghost" type="button" onClick={async () => { await fetch(`/api/launches/${picked.id}/connect/bing`, { method: "DELETE" }); setConn(await (await fetch(`/api/launches/${picked.id}/connections`)).json()); }}>Disconnect Bing</button> : null}
                <button className="btn ghost" type="button" onClick={async () => { await fetch(`/api/launches/${picked.id}/search/sync`, { method: "POST" }); }}>Sync search now</button>
              </div>
            ) : null}
            <div className="card" style={{ marginTop: 18 }}>
              <h3>API keys</h3>
              <p className="lede">For the CLI and MCP. The secret is shown once.</p>
              {keys.map((k) => (
                <p className="fine" key={k.id}>{k.name} · {k.prefix}… <button className="btn ghost" type="button" onClick={async () => { await fetch(`/api/keys/${k.id}`, { method: "DELETE" }); setKeys(keys.filter((x) => x.id !== k.id)); }}>Revoke</button></p>
              ))}
              {newKey ? <pre className="snippet">{newKey}</pre> : null}
              <button className="btn ghost" type="button" onClick={async () => {
                const res = await fetch("/api/keys", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "CLI" }) });
                const data = await res.json() as { key?: { secret: string; id: string; name: string; prefix: string; created_at: number } };
                if (data.key) {
                  setNewKey(data.key.secret);
                  setKeys([{ id: data.key.id, name: data.key.name, prefix: data.key.prefix, created_at: data.key.created_at }, ...keys]);
                }
              }}>Create API key</button>
            </div>
            {err ? <p className="err">{err}</p> : null}
            <DataRights setErr={setErr} />
          </section>
        ) : (
          <>
            <header className="work-head">
              <div>
                <h1>{picked?.name}</h1>
                <p className="fine">{picked?.site_url}</p>
              </div>
              <div className="hero-actions">
                {(["24h", "7d", "30d"] as const).map((r) => (
                  <button key={r} className={range === r ? "btn" : "btn ghost"} type="button" onClick={() => setRange(r)}>{r === "24h" ? "24h" : r === "7d" ? "7d" : "30d"}</button>
                ))}
                {picked ? <button className="btn ghost" type="button" onClick={() => { navigator.clipboard.writeText(picked.public_url); }}>Public URL</button> : null}
                {picked ? <button className="btn ghost" type="button" onClick={async () => {
                  const next = !(board?.live ?? true);
                  await fetch(`/api/launches/${picked.id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ launch_mode: next }) });
                  setBoard(board ? { ...board, live: next } : board);
                }}>{board?.live === false ? "Start live" : "Pause live"}</button> : null}
              </div>
            </header>
            {board ? <LaunchBoard data={board} launchId={picked?.id} touch={touch} onTouch={setTouch} liveLabel={range === "24h" ? "Last 24 hours" : range === "7d" ? "Last 7 days" : "Last 30 days"} /> : <div className="dash" style={{ minHeight: 320 }} />}
          </>
        )}
      </main>
    </div>
  );
}
