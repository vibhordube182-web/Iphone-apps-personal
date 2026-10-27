#!/usr/bin/env node
// Self-host / dev server: serves the app AND a tiny Firebase-compatible JSON database at /db,
// so the two phones can sync without Firebase.   Usage:  node server.js [port]
// Data is kept in ./data.json. Put it behind HTTPS (e.g. a tunnel, Render, Fly, Railway) for iPhones.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const dir = path.dirname(fileURLToPath(import.meta.url));
const FILE = process.env.RM_DATA || path.join(dir, "data.json");
const PORT = Number(process.argv[2] || process.env.PORT || 8080);
let tree = {};
try { tree = JSON.parse(fs.readFileSync(FILE, "utf8")); } catch (_) {}
let dirty = false;
setInterval(() => { if (dirty) { dirty = false; fs.writeFile(FILE, JSON.stringify(tree), () => {}); } }, 1500).unref();

const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".webmanifest": "application/manifest+json", ".png": "image/png", ".svg": "image/svg+xml" };
const segs = (p) => p.split("/").filter(Boolean);
const get = (parts) => { let n = tree; for (const s of parts) { if (n == null || typeof n !== "object") return null; n = n[s]; } return n === undefined ? null : n; };
function put(parts, val) {
  if (!parts.length) { tree = val || {}; return; }
  let n = tree;
  for (const s of parts.slice(0, -1)) { if (n[s] == null || typeof n[s] !== "object") n[s] = {}; n = n[s]; }
  const last = parts[parts.length - 1];
  if (val === null) delete n[last]; else n[last] = val;
}
function prune(n) { // like Firebase, empty objects vanish
  if (n && typeof n === "object") for (const k of Object.keys(n)) { prune(n[k]); if (n[k] && typeof n[k] === "object" && !Object.keys(n[k]).length) delete n[k]; }
}

http.createServer((req, res) => {
  const url = new URL(req.url, "http://x");
  const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "*", "Access-Control-Allow-Methods": "GET,PUT,PATCH,DELETE,OPTIONS", "Access-Control-Expose-Headers": "ETag" };
  if (req.method === "OPTIONS") { res.writeHead(204, cors); return res.end(); }

  if (url.pathname.startsWith("/db/")) {
    const parts = segs(decodeURIComponent(url.pathname.slice(4)).replace(/\.json$/, ""));
    if (parts.join("/") === "ping") { res.writeHead(200, { ...cors, "Content-Type": "application/json" }); return res.end('{"reelmatch":true}'); }
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const send = (code, data, extra = {}) => { res.writeHead(code, { ...cors, "Content-Type": "application/json", ...extra }); res.end(data === undefined ? "" : JSON.stringify(data)); };
      if (req.method === "GET") {
        const data = get(parts), json = JSON.stringify(data);
        const etag = '"' + crypto.createHash("md5").update(json).digest("hex") + '"';
        if (req.headers["if-none-match"] === etag) { res.writeHead(304, { ...cors, ETag: etag }); return res.end(); }
        return send(200, data, { ETag: etag });
      }
      let val; try { val = body ? JSON.parse(body) : null; } catch (_) { return send(400, { error: "bad json" }); }
      if (req.method === "PUT") put(parts, val);
      else if (req.method === "PATCH") for (const [k, v] of Object.entries(val || {})) put([...parts, k], v);
      else if (req.method === "DELETE") put(parts, null);
      else return send(405, { error: "method" });
      prune(tree); dirty = true;
      send(200, val);
    });
    return;
  }

  let f = path.join(dir, url.pathname === "/" ? "index.html" : decodeURIComponent(url.pathname));
  if (!f.startsWith(dir) || f.includes("data.json") || f.endsWith("server.js") || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); return res.end("not found"); }
  res.writeHead(200, { "Content-Type": MIME[path.extname(f)] || "application/octet-stream", "Cache-Control": "no-cache" });
  fs.createReadStream(f).pipe(res);
}).listen(PORT, () => console.log(`AshKey Entertainment on http://localhost:${PORT}  (sync database at /db)`));
