export type SourceRow = { name: string; visitors: number; revenue_cents: number };
export type PageRow = { path: string; views: number };
export type CountryRow = { country: string; visitors: number };
export type SearchRow = { query: string; clicks: number };
export type DeviceRow = { name: string; pct: number };

export type BoardData = {
  launch: { name: string; slug: string; site_url: string | null };
  stats: { views: number; unique: number; signups: number; revenue_cents: number };
  visitors: Array<{ id: string; kind: string; country: string | null; city: string | null; lat: number | null; lng: number | null; path: string | null; amount_cents: number; created_at: number; referrer?: string | null }>;
  sources?: SourceRow[];
  pages?: PageRow[];
  countries?: CountryRow[];
  search?: SearchRow[];
  ai?: SourceRow[];
  devices?: DeviceRow[];
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

function conv(stats: BoardData["stats"]) {
  if (!stats.unique) return "0%";
  return `${((stats.signups / stats.unique) * 100).toFixed(1)}%`;
}

function Bar({ value, max }: { value: number; max: number }) {
  const w = max <= 0 ? 0 : Math.max(4, Math.round((value / max) * 100));
  return <span className="bar"><i style={{ width: `${w}%` }} /></span>;
}

function Trend({ views, revenueCents }: { views: number; revenueCents: number }) {
  const n = 14;
  const vis = Array.from({ length: n }, (_, i) => Math.max(6, Math.round((views / n) * (0.5 + ((i * 3 + 5) % 8) / 14))));
  const rev = Array.from({ length: n }, (_, i) => Math.max(1, Math.round((Math.max(revenueCents, 1900) / n / 100) * (0.35 + ((i * 5 + 2) % 9) / 12))));
  const maxV = Math.max(...vis, 1);
  const maxR = Math.max(...rev, 1);
  const W = 520;
  const H = 148;
  const pad = 12;
  const bw = (W - pad * 2) / n;
  const line = vis.map((v, i) => `${pad + i * bw + bw / 2},${H - pad - (v / maxV) * (H - pad * 2)}`).join(" ");
  return (
    <div className="chart-wrap">
      <svg className="trend" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none">
        {vis.map((_, i) => (
          <rect key={i} x={pad + i * bw + 3} y={H - pad - (rev[i] / maxR) * (H - pad * 2)} width={Math.max(6, bw - 8)} height={(rev[i] / maxR) * (H - pad * 2)} rx="2" fill="#18181b" opacity="0.14" />
        ))}
        <polyline fill="none" stroke="#18181b" strokeWidth="1.6" points={line} />
        {vis.map((v, i) => (
          <circle key={i} cx={pad + i * bw + bw / 2} cy={H - pad - (v / maxV) * (H - pad * 2)} r="2.4" fill="#18181b" />
        ))}
      </svg>
      <div className="chart-legend"><span className="lg sky" /> Visitors <span className="lg coral" /> Revenue</div>
    </div>
  );
}

function World({ visitors, watermark }: { visitors: BoardData["visitors"]; watermark?: boolean }) {
  const w = 520;
  const h = 210;
  return (
    <div className="map-wrap">
      <svg className="world" viewBox={`0 0 ${w} ${h}`}>
        <rect width={w} height={h} fill="#f4f4f5" />
        <g fill="#e4e4e7" stroke="#d4d4d8" strokeWidth="0.6">
          <ellipse cx="118" cy="78" rx="78" ry="42" />
          <ellipse cx="132" cy="148" rx="32" ry="48" />
          <ellipse cx="248" cy="68" rx="38" ry="28" />
          <ellipse cx="252" cy="128" rx="36" ry="52" />
          <ellipse cx="360" cy="78" rx="92" ry="50" />
          <ellipse cx="430" cy="158" rx="36" ry="22" />
        </g>
        {visitors.map((v) => {
          if (v.lat == null || v.lng == null) return null;
          const [x, y] = project(v.lat, v.lng, w, h);
          return (
            <g key={v.id}>
              <circle cx={x} cy={y} r="8" fill="#18181b" opacity="0.18" />
              <circle cx={x} cy={y} r="3" fill="#18181b" />
            </g>
          );
        })}
      </svg>
      {watermark ? <div className="wm">Cairn</div> : null}
    </div>
  );
}

export default function LaunchBoard({ data, liveLabel }: { data: BoardData; liveLabel?: string }) {
  const sources = data.sources ?? [];
  const pages = data.pages ?? [];
  const countries = data.countries ?? [];
  const search = data.search ?? [];
  const ai = data.ai ?? [];
  const maxSrc = Math.max(1, ...sources.map((s) => s.visitors));
  const maxPage = Math.max(1, ...pages.map((p) => p.views));
  const online = Math.max(0, data.visitors.filter((v) => Date.now() - v.created_at < 120000).length);
  const host = (data.launch.site_url || "https://acme.example").replace(/^https?:\/\//, "");
  return (
    <div className="browser">
      <div className="dash">
        <div className="dash-head">
          <div>
            <div className="dash-kicker">{liveLabel ?? (data.demo ? "Last 30 days" : "Live")}</div>
            <strong>{host}</strong>
          </div>
          <span className="live-pill">{online} online</span>
        </div>
        <div className="metrics">
          <div className="metric"><span>Unique visitors</span><b>{data.stats.unique.toLocaleString()}</b></div>
          <div className="metric"><span>Signups</span><b>{data.stats.signups.toLocaleString()}</b></div>
          <div className="metric"><span>Revenue</span><b>{money(data.stats.revenue_cents)}</b></div>
          <div className="metric"><span>Signup rate</span><b>{conv(data.stats)}</b></div>
        </div>
        <Trend views={data.stats.views} revenueCents={data.stats.revenue_cents} />
        <div className="dash-main">
          <div className="dash-col">
            <h4>Channels that paid</h4>
            <div className="table">
              {sources.map((s) => (
                <div className="tr" key={s.name}>
                  <span className="td name">{s.name}</span>
                  <Bar value={s.visitors} max={maxSrc} />
                  <span className="td num">{s.visitors}</span>
                  <span className="td num">{money(s.revenue_cents)}</span>
                </div>
              ))}
            </div>
            <h4>AI referrers</h4>
            <div className="table">
              {ai.map((s) => (
                <div className="tr" key={s.name}>
                  <span className="td name">{s.name}</span>
                  <span className="td num">{s.visitors}</span>
                  <span className="td num">{money(s.revenue_cents)}</span>
                </div>
              ))}
            </div>
          </div>
          <div className="dash-col">
            <h4>Where they are</h4>
            <World visitors={data.visitors} watermark={data.watermark} />
            <div className="feed">
              {data.visitors.slice(0, 6).map((v) => (
                <div className="hit" key={v.id}>
                  <span className={`dot ${v.kind}`} />
                  <span>{v.city || v.country || "Unknown"} · {v.kind}{v.path ? ` · ${v.path}` : ""}</span>
                  <span>{ago(v.created_at)}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
        <div className="dash-split">
          <div>
            <h4>Pages</h4>
            <div className="table">
              {pages.map((p) => (
                <div className="tr" key={p.path}>
                  <span className="td name">{p.path}</span>
                  <Bar value={p.views} max={maxPage} />
                  <span className="td num">{p.views}</span>
                </div>
              ))}
            </div>
          </div>
          <div>
            <h4>Search queries</h4>
            <div className="table">
              {search.length ? search.map((q) => (
                <div className="tr" key={q.query}>
                  <span className="td name">{q.query}</span>
                  <span className="td num">{q.clicks}</span>
                </div>
              )) : <p className="muted">Connect Search Console to see queries next to revenue.</p>}
            </div>
            <h4>Countries</h4>
            <div className="chips">
              {countries.map((c) => (
                <span className="chip" key={c.country}>{c.country} {c.visitors}</span>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
