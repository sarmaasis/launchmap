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
    const id = setInterval(tick, 2800);
    return () => { alive = false; clearInterval(id); };
  }, []);
  return (
    <div className="wrap">
      <nav className="nav">
        <a className="brand" href="/" onClick={(e) => { e.preventDefault(); go("/"); }}><i /> Launchmap</a>
        <div className="nav-links">
          <a href="#pricing">Pricing</a>
          <button className="btn" onClick={() => go("/login")}>Get a board</button>
        </div>
      </nav>
      <section className="hero">
        <div>
          <div className="kicker">Public launch URL</div>
          <h1>A launch page worth tweeting.</h1>
          <p className="lede">Pay. Paste a 1KB script. Share a live board of visitors, signups, and the first dollar. Customers never clone anything.</p>
          <div className="hero-actions">
            <button className="btn" onClick={() => go("/login")}>Start free</button>
            <button className="btn ghost" onClick={() => document.getElementById("pricing")?.scrollIntoView({ behavior: "smooth" })}>See $9 and $19</button>
          </div>
        </div>
        {board ? <LaunchBoard data={board} liveLabel="Live demo" /> : <div className="board" style={{ minHeight: 420 }} />}
      </section>
      <section id="pricing" className="price-row">
        <div className="card"><h3>Free</h3><div className="amt">$0</div><p className="lede">One launch. Public URL. Embed script. Launchmap watermark on the board.</p></div>
        <div className="card"><h3>One launch</h3><div className="amt">$19 <span>once</span></div><p className="lede">Extra board. Watermark off. Keep it forever.</p></div>
        <div className="card"><h3>Monthly</h3><div className="amt">$9 <span>/mo</span></div><p className="lede">Unlimited boards. Watermark off. Tag Dodo revenue to a launch.</p></div>
      </section>
      <footer><span>Launchmap. Hosted. Not a starter kit.</span><span>MIT</span></footer>
    </div>
  );
}
