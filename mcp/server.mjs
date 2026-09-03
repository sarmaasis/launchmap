#!/usr/bin/env node
/**
 * Stdio JSON-RPC MCP subset for Cairn.
 * Env: CAIRN_API_KEY, CAIRN_API_URL (default https://cairn.app)
 */
import { createInterface } from "node:readline";

const API = (process.env.CAIRN_API_URL || "https://cairn.app").replace(/\/$/, "");
const KEY = process.env.CAIRN_API_KEY || "";

const TOOLS = [
  { name: "cairn_overview", description: "Site overview stats for a Cairn site id", path: (a) => `/api/v1/sites/${a.id}/overview` },
  { name: "cairn_sources", description: "Traffic sources for a Cairn site id", path: (a) => `/api/v1/sites/${a.id}/sources` },
  { name: "cairn_search", description: "Search Console and Bing queries for a Cairn site id", path: (a) => `/api/v1/sites/${a.id}/search` },
  { name: "cairn_funnel", description: "Land / pricing / checkout / paid funnel", path: (a) => `/api/v1/sites/${a.id}/funnel` },
  { name: "cairn_feed", description: "Recent visitor feed for a Cairn site id", path: (a) => `/api/v1/sites/${a.id}/feed` },
];

function schema() {
  return {
    type: "object",
    properties: {
      id: { type: "string", description: "Site / launch id" },
      range: { type: "string", description: "24h, 7d, or 30d" },
    },
    required: ["id"],
  };
}

async function callApi(path, range) {
  if (!KEY) throw new Error("CAIRN_API_KEY is not set");
  const url = range ? `${API}${path}?range=${encodeURIComponent(range)}` : `${API}${path}`;
  const res = await fetch(url, { headers: { authorization: `Bearer ${KEY}`, accept: "application/json" } });
  const text = await res.text();
  if (!res.ok) throw new Error(text || String(res.status));
  return text;
}

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + "\n");
}

async function handle(msg) {
  if (!msg || typeof msg !== "object") return;
  const { id, method, params } = msg;
  if (method === "notifications/initialized" || method === "notifications/cancelled") return;
  if (method === "initialize") {
    send({
      jsonrpc: "2.0",
      id,
      result: {
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "cairn", version: "1.0.0" },
      },
    });
    return;
  }
  if (method === "ping") {
    send({ jsonrpc: "2.0", id, result: {} });
    return;
  }
  if (method === "tools/list") {
    send({
      jsonrpc: "2.0",
      id,
      result: {
        tools: TOOLS.map((t) => ({ name: t.name, description: t.description, inputSchema: schema() })),
      },
    });
    return;
  }
  if (method === "tools/call") {
    const name = params?.name;
    const args = params?.arguments || {};
    const tool = TOOLS.find((t) => t.name === name);
    if (!tool) {
      send({ jsonrpc: "2.0", id, error: { code: -32601, message: "Unknown tool" } });
      return;
    }
    try {
      const text = await callApi(tool.path(args), args.range);
      send({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text }] } });
    } catch (err) {
      send({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: String(err?.message || err) }], isError: true } });
    }
    return;
  }
  if (id !== undefined) send({ jsonrpc: "2.0", id, error: { code: -32601, message: "Method not found" } });
}

const rl = createInterface({ input: process.stdin });
rl.on("line", (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  try {
    handle(JSON.parse(trimmed));
  } catch {
    send({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
  }
});
