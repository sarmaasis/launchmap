import { useState } from "react";

export type SourceRow = { name: string; visitors: number; revenue_cents: number };
export type PageRow = { path: string; views: number };
export type CountryRow = { country: string; visitors: number };
export type SearchRow = { query: string; clicks: number };
export type DeviceRow = { name: string; pct: number };
export type SeriesPoint = { hour_ts: number; views: number; uniques: number; signups: number; revenue_cents: number };
export type FunnelStep = { name: string; count: number };
export type VisitorHit = {
  id: string;
  kind: string;
  name?: string | null;
  vid?: string | null;
  country: string | null;
  city: string | null;
  lat: number | null;
  lng: number | null;
  path: string | null;
  amount_cents: number;
  created_at: number;
  referrer?: string | null;
  unverified?: boolean;
};

export type BoardData = {
  launch: { name: string; slug: string; site_url: string | null };
  stats: { views: number; unique: number; signups: number; revenue_cents: number; customers?: number; rpv?: number };
  visitors: VisitorHit[];
  sources?: SourceRow[];
  sources_last?: SourceRow[];
  pages?: PageRow[];
  countries?: CountryRow[];
  search?: SearchRow[];
  ai?: SourceRow[];
  devices?: DeviceRow[];
  series?: SeriesPoint[];
  funnel?: FunnelStep[];
  touch?: "first" | "last";
  live?: boolean;
  watermark?: boolean;
  demo?: boolean;
};

export type JourneyData = {
  vid: string;
  visitor: {
    first_referrer?: string | null;
    last_referrer?: string | null;
    first_path?: string | null;
    last_path?: string | null;
  } | null;
  events: Array<{ id: string; kind: string; name: string | null; path: string | null; referrer: string | null; amount_cents: number; created_at: number }>;
  payments: Array<{ id: string; amount_cents: number; refunded_cents: number; kind: string; provider: string; created_at: number }>;
};

function money(cents: number) {
  return `$${(cents / 100).toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`;
}

function moneyExact(cents: number) {
  return `$${(cents / 100).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
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

function Trend({ series }: { series: SeriesPoint[] }) {
  if (!series.length) {
    return (
      <div className="chart-wrap">
        <p className="muted">No hourly data yet. Traffic will plot here as it arrives.</p>
      </div>
    );
  }
  const vis = series.map((s) => s.views);
  const rev = series.map((s) => s.revenue_cents);
  const maxV = Math.max(...vis, 1);
  const maxR = Math.max(...rev, 1);
  const n = series.length;
  const W = 520;
  const H = 148;
  const pad = 12;
  const bw = (W - pad * 2) / n;
  const line = vis.map((v, i) => `${pad + i * bw + bw / 2},${H - pad - (v / maxV) * (H - pad * 2)}`).join(" ");
  const showBars = n <= 48;
  return (
    <div className="chart-wrap">
      <svg className="trend" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none">
        {showBars ? vis.map((_, i) => (
          <rect key={i} x={pad + i * bw + 1} y={H - pad - (rev[i] / maxR) * (H - pad * 2)} width={Math.max(2, bw - 3)} height={(rev[i] / maxR) * (H - pad * 2)} rx="1" fill="#18181b" opacity="0.14" />
        )) : null}
        <polyline fill="none" stroke="#18181b" strokeWidth="1.6" points={line} />
      </svg>
      <div className="chart-legend"><span className="lg sky" /> Views <span className="lg coral" /> Revenue</div>
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

function hitLine(v: VisitorHit) {
  const bits = [
    v.city || v.country || "Unknown",
    v.kind,
    v.name && v.name !== v.kind ? v.name : null,
    v.path,
    v.referrer && v.referrer !== "Direct" ? v.referrer : null,
    v.kind === "payment" && v.amount_cents ? money(v.amount_cents) : null,
    v.unverified ? "unverified" : null,
  ].filter(Boolean);
  return bits.join(" · ");
}

export default function LaunchBoard({
  data,
  liveLabel,
  launchId,
  touch,
  onTouch,
}: {
  data: BoardData;
  liveLabel?: string;
  launchId?: string;
  touch?: "first" | "last";
  onTouch?: (t: "first" | "last") => void;
}) {
  const mode = touch ?? data.touch ?? "first";
  const [localTouch, setLocalTouch] = useState<"first" | "last">(mode);
  const activeTouch = onTouch ? mode : localTouch;
  const [journey, setJourney] = useState<JourneyData | null>(null);
  const [journeyErr, setJourneyErr] = useState("");
  const sources = ((activeTouch === "last" && data.sources_last) ? data.sources_last : data.sources) ?? [];
  const pages = data.pages ?? [];
  const countries = data.countries ?? [];
  const search = data.search ?? [];
  const ai = data.ai ?? [];
  const funnel = data.funnel ?? [];
  const series = data.series ?? [];
  const maxSrc = Math.max(1, ...sources.map((s) => s.visitors));
  const maxPage = Math.max(1, ...pages.map((p) => p.views));
  const online = Math.max(0, data.visitors.filter((v) => Date.now() - v.created_at < 120000).length);
  const host = (data.launch.site_url || "https://acme.example").replace(/^https?:\/\//, "");
  const paidRevenue = data.stats.revenue_cents > 0;

  async function openJourney(vid: string) {
    if (!launchId || data.demo) {
      setJourney({
        vid,
        visitor: { first_referrer: data.visitors.find((v) => v.vid === vid)?.referrer || "Direct", first_path: "/" },
        events: data.visitors.filter((v) => v.vid === vid).slice().reverse().map((v) => ({
          id: v.id, kind: v.kind, name: v.name ?? null, path: v.path, referrer: v.referrer ?? null, amount_cents: v.amount_cents, created_at: v.created_at,
        })),
        payments: data.visitors.filter((v) => v.vid === vid && v.kind === "payment").map((v) => ({
          id: v.id, amount_cents: v.amount_cents, refunded_cents: 0, kind: "one_time", provider: "demo", created_at: v.created_at,
        })),
      });
      return;
    }
    setJourneyErr("");
    const res = await fetch(`/api/launches/${launchId}/journey/${encodeURIComponent(vid)}`);
    if (!res.ok) { setJourneyErr("Could not load journey."); return; }
    setJourney(await res.json() as JourneyData);
  }

  return (
    <div className="browser">
      <div className="dash">
        <div className="dash-head">
          <div>
            <div className="dash-kicker">{liveLabel ?? (data.demo ? "Live demo" : "Live")}</div>
            <strong>{host}</strong>
          </div>
          <span className="live-pill">{online} online</span>
        </div>
        <div className="metrics">
          <div className="metric"><span>Unique visitors</span><b>{data.stats.unique.toLocaleString()}</b></div>
          <div className="metric"><span>Signups</span><b>{data.stats.signups.toLocaleString()}</b></div>
          <div className="metric"><span>Customers</span><b>{(data.stats.customers ?? 0).toLocaleString()}</b></div>
          <div className="metric"><span>Revenue</span><b>{money(data.stats.revenue_cents)}</b></div>
          <div className="metric"><span>Revenue / visitor</span><b>{moneyExact(data.stats.rpv ?? 0)}</b></div>
          <div className="metric"><span>Signup rate</span><b>{conv(data.stats)}</b></div>
        </div>
        <Trend series={series} />
        {funnel.length ? (
          <div className="funnel">
            {funnel.map((step, i) => (
              <div className="funnel-step" key={step.name}>
                {i > 0 ? <span className="funnel-then">then</span> : null}
                <b>{step.count.toLocaleString()}</b>
                <span>{step.name}</span>
              </div>
            ))}
          </div>
        ) : null}
        <div className="dash-main">
          <div className="dash-col">
            <div className="h4-row">
              <h4>Channels that paid</h4>
              <div className="touch">
                <button type="button" className={activeTouch === "first" ? "btn" : "btn ghost"} onClick={() => (onTouch ? onTouch("first") : setLocalTouch("first"))}>First touch</button>
                <button type="button" className={activeTouch === "last" ? "btn" : "btn ghost"} onClick={() => (onTouch ? onTouch("last") : setLocalTouch("last"))}>Last touch</button>
              </div>
            </div>
            <div className="table">
              {sources.length ? sources.map((s) => (
                <div className="tr" key={s.name}>
                  <span className="td name">{s.name}</span>
                  <Bar value={s.visitors} max={maxSrc} />
                  <span className="td num">{s.visitors}</span>
                  <span className="td num">{paidRevenue || data.demo ? money(s.revenue_cents) : "$0"}</span>
                </div>
              )) : <p className="muted">No visitors in this range yet.</p>}
            </div>
            {!paidRevenue && !data.demo ? <p className="muted">Channel revenue is $0 until a Dodo or Stripe payment joins a visitor id.</p> : null}
            <h4>AI referrers</h4>
            <div className="table">
              {ai.length ? ai.map((s) => (
                <div className="tr" key={s.name}>
                  <span className="td name">{s.name}</span>
                  <span className="td num">{s.visitors}</span>
                  <span className="td num">{paidRevenue || data.demo ? money(s.revenue_cents) : "$0"}</span>
                </div>
              )) : <p className="muted">No AI referrers yet.</p>}
            </div>
          </div>
          <div className="dash-col">
            <h4>Where they are</h4>
            <World visitors={data.visitors} watermark={data.watermark} />
            <div className="feed">
              {data.visitors.slice(0, 12).map((v) => (
                <button className="hit" type="button" key={v.id} onClick={() => v.vid && openJourney(v.vid)} disabled={!v.vid}>
                  <span className={`dot ${v.kind}`} />
                  <span>{hitLine(v)}</span>
                  <span>{ago(v.created_at)}</span>
                </button>
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
      {journey ? (
        <aside className="journey">
          <div className="h4-row">
            <h4>Journey</h4>
            <button className="btn ghost" type="button" onClick={() => setJourney(null)}>Close</button>
          </div>
          {journeyErr ? <p className="err">{journeyErr}</p> : null}
          <p className="journey-line"><span>Source</span> {journey.visitor?.first_referrer || "Direct"}</p>
          <p className="funnel-then">then</p>
          <p className="journey-line"><span>Pages</span> {(journey.events.filter((e) => e.kind === "pageview").map((e) => e.path).filter(Boolean) as string[]).join(" then ") || journey.visitor?.first_path || "/"}</p>
          <p className="funnel-then">then</p>
          <p className="journey-line"><span>Events</span> {journey.events.filter((e) => e.kind === "event" || e.kind === "signup").map((e) => e.name || e.kind).join(" then ") || "none yet"}</p>
          <p className="funnel-then">then</p>
          <p className="journey-line"><span>Payment</span> {journey.payments.length ? journey.payments.map((p) => money(p.amount_cents - p.refunded_cents)).join(", ") : "none"}</p>
        </aside>
      ) : null}
    </div>
  );
}
