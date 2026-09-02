import { go } from "../lib/nav";

const PAGES: Record<string, { title: string; body: string[] }> = {
  privacy: {
    title: "Privacy",
    body: [
      "Cairn is the data controller for your account email. For visitor analytics, you (the site owner) are the controller. We are the processor.",
      "The tracker is cookieless. It does not set a tracking cookie. Visitor ids rotate every UTC day from IP, user agent, and a server pepper. That is enough to count uniques for one day, not to follow a person across weeks.",
      "We store page path, classified referrer, coarse Cloudflare country, device class, optional UTM tags, event kind, and payment amounts you send or that Dodo posts to us. We do not store names, emails, or IP addresses of your visitors.",
      "Trial accounts keep events 14 days. Pro and Business keep events 3 years. Webhook payloads are dropped after 30 days. Magic links expire in 15 minutes.",
      "Export your data at any time from the app (JSON). Erase your account and all events from the same screen. Email sarmaasis@gmail.com for a human request. We use Cloudflare (Workers, D1, Email Sending) and Dodo Payments as processors.",
    ],
  },
  terms: {
    title: "Terms",
    body: [
      "Cairn is a hosted analytics product. You paste our script, we show dashboards. You may not scrape, resell, or overload the service.",
      "Do not use the service to track children, health, or other special-category data. Do not load the script on sites you do not operate.",
      "Plans: 14-day trial, Pro 29 USD per month, Business 79 USD per month. Billing is Dodo Payments. If a webhook does not arrive, email us. Chargebacks can freeze the account.",
      "We may drop bot traffic and rate-limit collect. Availability is best effort on Cloudflare. MIT license covers the source. These terms cover the hosted service.",
    ],
  },
  dpa: {
    title: "Data processing addendum",
    body: [
      "This DPA applies when you (controller) send visitor events to Cairn (processor) to provide analytics.",
      "Subject matter: web analytics events. Duration: while your account exists, then until retention or erasure completes. Nature: collect, store, aggregate, display, delete.",
      "Types of data: hashed daily visitor id, path, referrer class, country, device class, UTM, event kind, amount. No special categories. Data subjects: visitors to your sites.",
      "We follow your instructions: process events for dashboards, export on request, erase on request or when retention ends. Subprocessors: Cloudflare, Inc. (compute and database, country of processing depends on the request), Dodo Payments (billing for your subscription, not visitor events).",
      "We assist with data subject requests that reach us, keep events in D1 with access limited to the service, and notify you without undue delay if we become aware of a personal data breach affecting your events.",
      "On account erasure we delete events, boards, sessions, and login tokens. Aggregated demo data on the marketing site is synthetic and not your visitors.",
    ],
  },
};

export default function Legal({ slug }: { slug: "privacy" | "terms" | "dpa" }) {
  const page = PAGES[slug];
  return (
    <div className="wrap">
      <nav className="nav">
        <a className="brand" href="/" onClick={(e) => { e.preventDefault(); go("/"); }}><i /> Cairn</a>
      </nav>
      <div className="card" style={{ maxWidth: 720, margin: "24px auto 64px" }}>
        <h1 style={{ fontSize: 32, marginBottom: 16 }}>{page.title}</h1>
        {page.body.map((p) => <p className="lede" key={p.slice(0, 24)} style={{ maxWidth: "none" }}>{p}</p>)}
      </div>
    </div>
  );
}
