import { useEffect, useState } from "react";
import { go } from "../lib/nav";
import LaunchBoard, { type BoardData } from "../ui/LaunchBoard";

export default function PublicLaunch({ slug }: { slug: string }) {
  const [board, setBoard] = useState<BoardData | null>(null);
  const [missing, setMissing] = useState(false);
  useEffect(() => {
    let alive = true;
    const tick = async () => {
      const res = await fetch(`/api/public/${encodeURIComponent(slug)}`);
      if (!alive) return;
      if (res.status === 404) { setMissing(true); return; }
      if (!res.ok) return;
      setBoard((await res.json()) as BoardData);
    };
    tick();
    const id = setInterval(tick, 3000);
    return () => { alive = false; clearInterval(id); };
  }, [slug]);
  if (missing) return <div className="wrap"><p>No launch at /l/{slug}.</p></div>;
  if (!board) return <div className="wrap"><p>Loading board…</p></div>;
  return (
    <div className="wrap">
      <nav className="nav">
        <a className="brand" href="/" onClick={(e) => { e.preventDefault(); go("/"); }}><i /> Launchmap</a>
        <button className="btn ghost" onClick={() => navigator.clipboard.writeText(window.location.href)}>Copy tweet URL</button>
      </nav>
      <h1 style={{ fontSize: 42, marginBottom: 18 }}>{board.launch.name}</h1>
      <LaunchBoard data={board} />
      <p className="lede" style={{ marginTop: 18 }}>{board.launch.site_url ? `Tracking ${board.launch.site_url}` : "Add the embed script to start real traffic."}</p>
    </div>
  );
}
