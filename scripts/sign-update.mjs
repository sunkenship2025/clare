#!/usr/bin/env node
// Writes dist/bin/update.json (version + each binary's SHA-256) and update.json.sig, its ed25519
// signature, for computers that update themselves (docs/ARCHITECTURE.md → Updates). The release
// workflow runs it after scripts/build.mjs with the private key in CLARE_SIGNING_KEY (PEM).

import { createHash, createPrivateKey, createPublicKey, sign, verify } from "node:crypto";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const BIN = join(ROOT, "dist", "bin");
const config = JSON.parse(readFileSync(join(ROOT, "clare.config.json"), "utf8"));
const pem = process.env.CLARE_SIGNING_KEY ?? "";

if (!config.updateKey) {
  console.log("· no updateKey in clare.config.json: computers don't update themselves, nothing to sign");
  process.exit(0);
}
if (!pem.trim()) {
  console.error("CLARE_SIGNING_KEY isn't set, so computers can't update to this release. Run: scripts/setup.sh updates");
  process.exit(1);
}

const version = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).version;
const files = {};
for (const name of readdirSync(BIN).sort()) {
  if (name.startsWith("clare-")) files[name] = createHash("sha256").update(readFileSync(join(BIN, name))).digest("hex");
}
if (!Object.keys(files).length) {
  console.error("No binaries in dist/bin. Run node scripts/build.mjs first.");
  process.exit(1);
}
const body = Buffer.from(JSON.stringify({ version, files }, null, 2) + "\n");
const sig = sign(null, body, createPrivateKey(pem));

// The key that signs has to be the one built into clare, or no computer would accept it.
const pub = createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: Buffer.from(config.updateKey, "base64").toString("base64url") }, format: "jwk" });
if (!verify(null, body, pub, sig)) {
  console.error("CLARE_SIGNING_KEY doesn't match updateKey in clare.config.json. Run: scripts/setup.sh updates");
  process.exit(1);
}
writeFileSync(join(BIN, "update.json"), body);
writeFileSync(join(BIN, "update.json.sig"), sig.toString("base64") + "\n");
console.log(`✓ update     dist/bin/update.json (clare ${version}, ${Object.keys(files).length} downloads, signed)`);
