#!/usr/bin/env node
// Copy the extension to a folder you can "Load unpacked", with the URL placeholders filled.
// Chrome refuses a manifest with unreplaced match patterns, so use this for local dev
// (the real packaging is scripts/build.mjs at the repo root).
//
//   node extension/scripts/stage.mjs                              # → extension/.dev-build (localhost)
//   node extension/scripts/stage.mjs --api https://x.supabase.co/functions/v1/api \
//                                    --web https://you.github.io/clare --out /tmp/clare-ext

import { cpSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, extname, join, relative, resolve } from "node:path";

const SRC = resolve(dirname(new URL(import.meta.url).pathname), "..");
const argv = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = argv.indexOf(name);
  return i !== -1 && argv[i + 1] ? argv[i + 1] : fallback;
};

const strip = (u) => String(u).replace(/\/+$/, "");
const api = strip(arg("--api", "http://localhost:8787"));
const web = strip(arg("--web", "http://localhost:8788"));
const out = resolve(arg("--out", join(SRC, ".dev-build")));

const values = {
  __CLARE_API_URL__: api,
  __CLARE_API_ORIGIN__: new URL(api).origin,
  __CLARE_WEB_URL__: web,
};
const SKIP = new Set(["test", "scripts", "dev", ".dev-build", "README.md", "node_modules"]);
const TEXT = new Set([".html", ".js", ".css", ".json"]);

rmSync(out, { recursive: true, force: true });
cpSync(SRC, out, {
  recursive: true,
  filter: (p) => {
    const rel = relative(SRC, p);
    return !rel || !SKIP.has(rel.split(/[\\/]/)[0]);
  },
});

(function fill(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) fill(p);
    else if (TEXT.has(extname(p))) {
      let s = readFileSync(p, "utf8");
      for (const [k, v] of Object.entries(values)) s = s.replaceAll(k, v);
      writeFileSync(p, s);
    }
  }
})(out);

console.log(`Staged extension → ${out}\n  api ${api}\n  web ${web}\nchrome://extensions → Developer mode → Load unpacked → pick that folder.`);
