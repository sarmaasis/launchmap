import { go } from "../lib/nav";

export default function Success() {
  return (
    <div className="wrap">
      <nav className="nav"><a className="brand" href="/" onClick={(e) => { e.preventDefault(); go("/"); }}><i /> Cairn</a></nav>
      <div className="card" style={{ maxWidth: 520, margin: "40px auto" }}>
        <h2>Payment received.</h2>
        <p className="lede">Your subscription is unlocking. If the dashboard still shows a trial watermark, wait a few seconds for the webhook, then refresh.</p>
        <button className="btn" onClick={() => go("/app")}>Open dashboard</button>
      </div>
    </div>
  );
}
