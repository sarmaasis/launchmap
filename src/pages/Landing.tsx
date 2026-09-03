import { useEffect, useState } from "react";
import { go } from "../lib/nav";
import LaunchBoard, { type BoardData } from "../ui/LaunchBoard";

export default function Landing() {
  const [board, setBoard] = useState<BoardData | null>(null);
  useEffect(() => {
    let alive = true;
    const tick = async () => {
      const res = await fetch("/api/demo");
      if (!res.ok || !alive) return;
      setBoard((await res.json()) as BoardData);
    };
    tick();
    const id = setInterval(tick, 3000);
    return () => { alive = false; clearInterval(id); };
  }, []);
  const online = board ? Math.max(0, board.visitors.filter((v) => Date.now() - v.created_at < 120000).length) : 0;
  return (
    <div className="marketing">
      <nav className="nav wrap">
        <a className="brand" href="/" onClick={(e) => { e.preventDefault(); go("/"); }}><i /> Cairn</a>
        <div className="nav-links">
          <a href="#product">Product</a>
          <a href="#pricing">Pricing</a>
          <button className="btn ghost" type="button" onClick={() => go("/login")}>Sign in</button>
          <button className="btn" type="button" onClick={() => go("/login")}>Start trial</button>
        </div>
      </nav>
      <header className="mast wrap">
        <p className="kicker">Revenue analytics</p>
        <h1>Which visit paid?</h1>
        <p className="lede mast-lede">A payment hits the board next to the visit that earned it. Cairn joins them with a first-party visitor id and checkout metadata. Search Console, Bing, Stripe, Dodo, Polar, Paddle, and Lemon Squeezy webhooks plus an API for CLI and MCP exist; they need keys or OAuth before anything shows up.</p>
        <div className="hero-actions">
          <button className="btn" type="button" onClick={() => go("/login")}>Start trial</button>
          <a className="text-link" href="#product">See the board</a>
        </div>
        <p className="fine">{online ? `${online} on the live demo. ` : ""}14-day trial. No card. Then $29/mo.</p>
      </header>
      <section id="product" className="wrap hero-board">
        {board ? <LaunchBoard data={board} liveLabel="Live demo" /> : <div className="browser" style={{ minHeight: 360 }} />}
      </section>
      <section className="wrap manifesto">
        <h2>The board is the product.</h2>
        <dl className="jobs">
          <div>
            <dt>Channel to cash</dt>
            <dd>Twitter, ads, direct. Ranked by payments joined to a visitor, not by guessed totals.</dd>
          </div>
          <div>
            <dt>Search beside dollars</dt>
            <dd>Queries sit next to revenue so you know which terms close.</dd>
          </div>
          <div>
            <dt>AI referrers</dt>
            <dd>ChatGPT, Perplexity, Claude, Gemini. Their own channel, not a leftover.</dd>
          </div>
          <div>
            <dt>Public live URL</dt>
            <dd>Map, signups, first dollar. No login to view. Post it.</dd>
          </div>
        </dl>
      </section>
      <section id="pricing" className="wrap price-row two">
        <div className="card featured">
          <h3>Pro</h3>
          <div className="amt">$29 <span>/mo</span></div>
          <p className="lede">10 websites, 500k events, revenue, AI referrers, public boards, 3 years of history. 14-day trial.</p>
        </div>
        <div className="card">
          <h3>Business</h3>
          <div className="amt">$79 <span>/mo</span></div>
          <p className="lede">50 websites, 2M events, Search Console connect, no watermark, room for a team.</p>
        </div>
      </section>
      <footer className="wrap">
        <span>Cairn</span>
        <span>
          <a href="/privacy" onClick={(e) => { e.preventDefault(); go("/privacy"); }}>Privacy</a>
          {" · "}
          <a href="/terms" onClick={(e) => { e.preventDefault(); go("/terms"); }}>Terms</a>
          {" · "}
          <a href="/dpa" onClick={(e) => { e.preventDefault(); go("/dpa"); }}>DPA</a>
        </span>
      </footer>
    </div>
  );
}
