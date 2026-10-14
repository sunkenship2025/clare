// Manifest sanity + the dev staging script produces a loadable manifest.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const EXT = join(dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(readFileSync(join(EXT, "manifest.json"), "utf8"));

function referencedFiles(m) {
  const files = [m.background.service_worker, m.action.default_popup];
  files.push(...Object.values(m.icons), ...Object.values(m.action.default_icon));
  for (const cs of m.content_scripts) files.push(...(cs.js || []), ...(cs.css || []));
  return files;
}

test("manifest is MV3 with the expected permissions and placeholders", () => {
  assert.equal(manifest.manifest_version, 3);
  assert.deepEqual(manifest.permissions.sort(), ["alarms", "notifications", "storage"]);
  assert.ok(manifest.host_permissions.includes("https://claude.ai/*"));
  assert.ok(manifest.host_permissions.includes("__CLARE_API_ORIGIN__/*"));
  assert.ok(manifest.content_scripts.some((cs) => cs.matches.includes("__CLARE_WEB_URL__/enroll.html*")));
  const main = manifest.content_scripts.find((cs) => cs.world === "MAIN");
  assert.deepEqual(main.js, ["lib/page.js", "content/inject.js"]);
  // Chrome injects a file once per frame — a file listed for both worlds would be missing from one.
  const isolated = manifest.content_scripts.filter((cs) => cs.world !== "MAIN" && cs.matches.includes("https://claude.ai/*"));
  for (const cs of isolated) for (const f of cs.js) assert.ok(!main.js.includes(f), `${f} is in both worlds`);
  assert.equal(main.run_at, "document_start");
  assert.equal(manifest.background.type, "module");
});

test("every file the manifest and popup reference exists", () => {
  for (const f of referencedFiles(manifest)) assert.ok(existsSync(join(EXT, f)), f);
  const html = readFileSync(join(EXT, "popup/popup.html"), "utf8");
  for (const [, src] of html.matchAll(/(?:src|href)="([^"#:]+)"/g)) {
    assert.ok(existsSync(join(EXT, "popup", src)), `popup → ${src}`);
  }
  for (const s of [16, 32, 48, 128]) {
    const png = readFileSync(join(EXT, `icons/${s}.png`));
    assert.equal(png.readUInt32BE(16), s, `icons/${s}.png width`);
  }
});

test("no remote code, no eval", () => {
  const js = ["sw.js", "config.js", "lib/core.js", "lib/page.js", "content/inject.js", "content/claude.js", "content/enroll.js", "popup/popup.js"];
  for (const f of js) {
    const src = readFileSync(join(EXT, f), "utf8");
    assert.doesNotMatch(src, /\beval\(|importScripts\(\s*["']https?:/, f);
    assert.doesNotMatch(src, /<script[^>]+src=["']https?:/, f);
  }
});

test("stage.mjs fills placeholders into a loadable copy", () => {
  const out = mkdtempSync(join(tmpdir(), "clare-ext-"));
  try {
    execFileSync(process.execPath, [
      join(EXT, "scripts/stage.mjs"),
      "--api",
      "https://abcd.supabase.co/functions/v1/api/",
      "--web",
      "https://pranav.github.io/clare/",
      "--out",
      out,
    ]);
    const staged = readFileSync(join(out, "manifest.json"), "utf8");
    assert.doesNotMatch(staged, /__CLARE_/);
    const m = JSON.parse(staged);
    assert.ok(m.host_permissions.includes("https://abcd.supabase.co/*"));
    assert.ok(m.content_scripts.some((cs) => cs.matches.includes("https://pranav.github.io/clare/enroll.html*")));
    const cfg = readFileSync(join(out, "config.js"), "utf8");
    assert.match(cfg, /"https:\/\/abcd\.supabase\.co\/functions\/v1\/api"/);
    assert.ok(!existsSync(join(out, "test")) && !existsSync(join(out, "scripts")) && !existsSync(join(out, "README.md")));
    for (const f of referencedFiles(m)) assert.ok(existsSync(join(out, f)), f);
    assert.ok(readdirSync(out).includes("sw.js"));
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});

test("config.js falls back to local dev servers when placeholders are unreplaced", () => {
  const g = {};
  new Function("globalThis", readFileSync(join(EXT, "config.js"), "utf8"))(g);
  assert.deepEqual(g.CLARE_CONFIG, { apiUrl: "http://localhost:8787", webUrl: "http://localhost:8788" });
});
