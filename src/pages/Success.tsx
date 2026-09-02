import { go } from "../lib/nav";

export default function Success() {
  return (
    <div className="wrap">
      <nav className="nav"><a className="brand" href="/" onClick={(e) => { e.preventDefault(); go("/"); }}><i /> Launchmap</a></nav>
      <div className="card" style={{ maxWidth: 520, margin: "40px auto" }}>
        <h2>Payment received.</h2>
        <p className="lede">Dodo will hit /webhooks/dodo with payment.succeeded or subscription.active. That is what unlocks boards and drops the watermark. If you closed checkout early, the webhook still wins.</p>
        <button className="btn" onClick={() => go("/app")}>Back to your launches</button>
      </div>
    </div>
  );
}
