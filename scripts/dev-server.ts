// Local dev: runs the real clare API (same handler as the edge function) on :8787 against a local
// Postgres, and serves web/ on :8788 with config placeholders filled in.
//
//   scripts/dev-db.sh start        # throwaway Postgres on :54329 with the schema applied
//   node scripts/dev-server.ts     # API + web
//
// Env: DATABASE_URL, PORT (8787), WEB_PORT (8788), CLARE_SETUP_SECRET (default "dev-secret").

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize, resolve } from "node:path";
import postgres from "postgres";
import { createApp } from "../supabase/functions/_shared/app.ts";

const ROOT = resolve(import.meta.dirname, "..");
const PORT = Number(process.env.PORT ?? 8787);
const WEB_PORT = Number(process.env.WEB_PORT ?? 8788);
const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://localhost:54329/clare";
const API_URL = `http://localhost:${PORT}`;
const WEB_URL = `http://localhost:${WEB_PORT}`;

const sql = postgres(DATABASE_URL, { max: 5, onnotice: () => {} });
const handle = createApp({ sql, setupSecret: process.env.CLARE_SETUP_SECRET ?? "dev-secret" });

async function toRequest(req: IncomingMessage, base: string): Promise<Request> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) if (typeof v === "string") headers.set(k, v);
  const hasBody = req.method !== "GET" && req.method !== "HEAD" && chunks.length > 0;
  return new Request(new URL(req.url ?? "/", base), {
    method: req.method,
    headers,
    body: hasBody ? Buffer.concat(chunks) : undefined,
  });
}

async function send(res: ServerResponse, r: Response) {
  res.writeHead(r.status, Object.fromEntries(r.headers));
  res.end(Buffer.from(await r.arrayBuffer()));
}

createServer(async (req, res) => {
  const started = performance.now();
  const r = await handle(await toRequest(req, API_URL));
  await send(res, r);
  console.log(`api ${req.method} ${req.url} → ${r.status} ${(performance.now() - started).toFixed(0)}ms`);
}).listen(PORT, () => console.log(`clare api  ${API_URL}`));

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".json": "application/json",
  ".sh": "text/plain; charset=utf-8",
  ".ps1": "text/plain; charset=utf-8",
  ".zip": "application/zip",
};

function fill(text: string): string {
  return text
    .replaceAll("__CLARE_API_URL__", API_URL)
    .replaceAll("__CLARE_WEB_URL__", WEB_URL)
    .replaceAll("__CLARE_RELEASES_URL__", `${WEB_URL}/_bin`);
}

createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", WEB_URL);
  let path = decodeURIComponent(url.pathname);
  // Local release binaries from `node scripts/build.mjs` are served as the "releases" URL.
  const dir = path.startsWith("/_bin/") ? join(ROOT, "dist", "bin") : join(ROOT, "web");
  if (path.startsWith("/_bin/")) path = path.slice("/_bin".length);
  if (path.endsWith("/")) path += "index.html";
  const file = normalize(join(dir, path));
  if (!file.startsWith(dir)) return void res.writeHead(403).end();
  try {
    if (!(await stat(file)).isFile()) throw new Error("not a file");
    const type = TYPES[extname(file)] ?? "application/octet-stream";
    const raw = await readFile(file);
    const out = type.startsWith("text/") || type === "application/json" ? fill(raw.toString("utf8")) : raw;
    res.writeHead(200, { "content-type": type, "cache-control": "no-store" }).end(out);
  } catch {
    res.writeHead(404, { "content-type": "text/plain" }).end("not found");
  }
}).listen(WEB_PORT, () => console.log(`clare web  ${WEB_URL}`));
