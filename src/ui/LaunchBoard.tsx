export type BoardData = {
  launch: { name: string; slug: string; site_url: string | null };
  stats: { views: number; unique: number; signups: number; revenue_cents: number };
  visitors: Array<{ id: string; kind: string; country: string | null; city: string | null; lat: number | null; lng: number | null; path: string | null; amount_cents: number; created_at: number }>;
  watermark?: boolean;
  demo?: boolean;
};

function money(cents: number) {
  return `$${(cents / 100).toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`;
}

function project(lat: number, lng: number, w: number, h: number) {
  return [((lng + 180) / 360) * w, ((90 - lat) / 180) * h] as const;
}

function ago(ts: number) {
  const s = Math.max(1, Math.round((Date.now() - ts) / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.round(s / 60)}m`;
  return `${Math.round(s / 3600)}h`;
}

export default function LaunchBoard({ data, liveLabel }: { data: BoardData; liveLabel?: string }) {
  const w = 640;
  const h = 280;
  const land = Array.from({ length: 220 }, (_, i) => {
    const lng = ((i * 47) % 360) - 180;
    const lat = Math.sin(i * 0.37) * 55;
    const [x, y] = project(lat, lng, w, h);
    return { x, y, i };
  });
  return (
    <div className="board">
      <div className="board-head">
        <div>
          <div className="kicker">{liveLabel ?? (data.demo ? "Live demo" : "Live")}</div>
          <strong>{data.launch.name}</strong>
        </div>
        <span className="ok">● {data.demo ? "seeded traffic" : "collecting"}</span>
      </div>
      <div className="stats">
        <div className="stat"><b>{data.stats.views.toLocaleString()}</b><span>Views</span></div>
        <div className="stat"><b>{data.stats.unique.toLocaleString()}</b><span>Unique</span></div>
        <div className="stat"><b>{data.stats.signups.toLocaleString()}</b><span>Signups</span></div>
        <div className="stat"><b>{money(data.stats.revenue_cents)}</b><span>Revenue</span></div>
      </div>
      <div className="globe-wrap">
        <svg className="globe" viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="xMidYMid slice">
          <ellipse cx={w / 2} cy={h / 2} rx={210} ry={118} fill="none" stroke="#1e3d32" strokeWidth="1" />
          {land.map((p) => (
            <circle key={p.i} cx={p.x} cy={p.y} r="1.1" fill="#1f3f33" />
          ))}
          {data.visitors.map((v) => {
            if (v.lat == null || v.lng == null) return null;
            const [x, y] = project(v.lat, v.lng, w, h);
            return (
              <g key={v.id}>
                <circle cx={x} cy={y} r="9" fill="none" stroke={v.kind === "payment" ? "#ffb020" : "#c8f542"} strokeOpacity="0.35" />
                <circle className="ping" cx={x} cy={y} r="3.2" />
              </g>
            );
          })}
        </svg>
        {data.watermark ? <div className="wm">Launchmap</div> : null}
      </div>
      <div className="feed">
        {data.visitors.map((v) => (
          <div className="hit" key={v.id}>
            <span className={`dot ${v.kind}`} />
            <span>{v.city || v.country || "Unknown"} · {v.kind}{v.path ? ` · ${v.path}` : ""}</span>
            <span>{ago(v.created_at)}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
