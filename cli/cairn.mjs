#!/usr/bin/env node
/**
 * Cairn CLI. No extra deps.
 *   CAIRN_API_KEY=lm_live_... CAIRN_API_URL=https://your-host node cli/cairn.mjs whoami
 */
const API = (process.env.CAIRN_API_URL || "https://cairn.app").replace(/\/$/, "");
const KEY = process.env.CAIRN_API_KEY || "";

async function api(path) {
  if (!KEY) {
    console.error("Set CAIRN_API_KEY to an lm_live_ key from Plan in the app.");
    process.exit(1);
  }
  const res = await fetch(`${API}${path}`, { headers: { authorization: `Bearer ${KEY}`, accept: "application/json" } });
  const text = await res.text();
  let body;
  try { body = JSON.parse(text); } catch { body = { error: text || res.statusText }; }
  if (!res.ok) {
    console.error(body.error || res.status);
    process.exit(1);
  }
  return body;
}

const [cmd, id] = process.argv.slice(2);
const needId = new Set(["overview", "sources", "search"]);

if (!cmd || cmd === "help" || cmd === "-h" || cmd === "--help") {
  console.log("cairn whoami | sites | overview <id> | sources <id> | search <id>");
  console.log("Env: CAIRN_API_KEY (required), CAIRN_API_URL (default https://cairn.app)");
  process.exit(0);
}

if (needId.has(cmd) && !id) {
  console.error(`${cmd} needs a site id`);
  process.exit(1);
}

const routes = {
  whoami: "/api/v1/me",
  sites: "/api/v1/sites",
  overview: `/api/v1/sites/${id}/overview`,
  sources: `/api/v1/sites/${id}/sources`,
  search: `/api/v1/sites/${id}/search`,
};

if (!routes[cmd]) {
  console.error("unknown command");
  process.exit(1);
}

const data = await api(routes[cmd]);
console.log(JSON.stringify(data, null, 2));
