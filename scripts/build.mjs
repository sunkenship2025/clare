#!/usr/bin/env node
// Build everything a deployment needs from clare.config.json:
//   dist/web/                 static site (GitHub Pages), incl. clare-extension.zip
//   dist/extension/           unpacked extension with real URLs
//   dist/clare-extension.zip  for the Chrome Web Store / manual install
//   dist/bin/clare-<os>-<arch>[.exe]
//
//   node scripts/build.mjs            # everything
//   node scripts/build.mjs --no-bin   # skip Go cross-compiles
//   node scripts/build.mjs --config other.json

import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { extname, join, relative, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const DIST = join(ROOT, "dist");
const argv = process.argv.slice(2);
const args = new Set(argv);
const configPath = argv.includes("--config") ? resolve(argv[argv.indexOf("--config") + 1]) : join(ROOT, "clare.config.json");

const config = JSON.parse(readFileSync(configPath, "utf8"));
for (const k of ["apiUrl", "webUrl", "releasesUrl"]) {
  if (!config[k] || String(config[k]).includes("YOUR_")) {
    console.error(`clare.config.json: set "${k}" first (scripts/setup.sh does this for you).`);
    process.exit(1);
  }
}
const strip = (u) => String(u).replace(/\/+$/, "");
const values = {
  __CLARE_API_URL__: strip(config.apiUrl),
  __CLARE_API_ORIGIN__: new URL(config.apiUrl).origin,
  __CLARE_WEB_URL__: strip(config.webUrl),
  __CLARE_RELEASES_URL__: strip(config.releasesUrl),
  __CLARE_EXTENSION_URL__: config.extensionUrl ?? "",
  __CLARE_VERSION__: JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).version ?? "0.1.0",
};

const TEXT = new Set([".html", ".js", ".mjs", ".css", ".json", ".sh", ".ps1", ".svg", ".txt", ".md"]);

function fillTree(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) fillTree(p);
    else if (TEXT.has(extname(p))) {
      let s = readFileSync(p, "utf8");
      for (const [k, v] of Object.entries(values)) s = s.replaceAll(k, v);
      writeFileSync(p, s);
    }
  }
}

function copy(from, to, skip = []) {
  cpSync(from, to, {
    recursive: true,
    filter: (src) => !skip.some((s) => relative(from, src).split("/")[0] === s),
  });
}

rmSync(DIST, { recursive: true, force: true });
mkdirSync(DIST, { recursive: true });

// Extension
copy(join(ROOT, "extension"), join(DIST, "extension"), ["test", "dev", "README.md", "node_modules", "scripts"]);
fillTree(join(DIST, "extension"));
const leftover = readFileSync(join(DIST, "extension", "manifest.json"), "utf8").match(/__CLARE_[A-Z_]+__/);
if (leftover) throw new Error(`manifest still has ${leftover[0]}`);
execFileSync("zip", ["-qr", join(DIST, "clare-extension.zip"), "."], { cwd: join(DIST, "extension") });
console.log("✓ extension  dist/clare-extension.zip");

// Web
copy(join(ROOT, "web"), join(DIST, "web"), ["dev"]);
fillTree(join(DIST, "web"));
cpSync(join(DIST, "clare-extension.zip"), join(DIST, "web", "clare-extension.zip"));
writeFileSync(join(DIST, "web", ".nojekyll"), "");
console.log("✓ web        dist/web/");

// CLI
if (!args.has("--no-bin")) {
  const targets = [
    ["darwin", "arm64"], ["darwin", "amd64"],
    ["linux", "amd64"], ["linux", "arm64"],
    ["windows", "amd64"],
  ];
  mkdirSync(join(DIST, "bin"), { recursive: true });
  // The binary carries the built extension (cli/ext, go:embed) so `clare enroll` can write it
  // to disk for "Load unpacked". Emptied again afterwards so plain `go build` stays extension-free.
  const EXT = join(ROOT, "cli", "ext");
  const clearExt = () => {
    for (const name of readdirSync(EXT)) if (name !== "README.md") rmSync(join(EXT, name), { recursive: true, force: true });
  };
  clearExt();
  cpSync(join(DIST, "extension"), EXT, { recursive: true });
  const ldflags = [
    "-s", "-w",
    `-X main.version=${values.__CLARE_VERSION__}`,
    `-X main.defaultAPI=${values.__CLARE_API_URL__}`,
    `-X main.defaultWeb=${values.__CLARE_WEB_URL__}`,
  ].join(" ");
  for (const [goos, goarch] of targets) {
    const out = join(DIST, "bin", `clare-${goos}-${goarch}${goos === "windows" ? ".exe" : ""}`);
    execFileSync("go", ["build", "-trimpath", "-ldflags", ldflags, "-o", out, "."], {
      cwd: join(ROOT, "cli"),
      env: { ...process.env, GOOS: goos, GOARCH: goarch, CGO_ENABLED: "0" },
      stdio: "inherit",
    });
  }
  clearExt();
  console.log(`✓ cli        dist/bin/ (${targets.length} targets, extension bundled)`);
}

if (!existsSync(join(DIST, "web", "install.sh"))) console.warn("! web/install.sh is missing");
