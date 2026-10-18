#!/usr/bin/env node
// Makes the release signing key once (.clare-update-key.pem, git-ignored, never printed) and puts
// its public half in clare.config.json as updateKey, which scripts/build.mjs builds into clare.
// scripts/setup.sh updates also stores the private key as the CLARE_SIGNING_KEY Actions secret.

import { createPrivateKey, createPublicKey, generateKeyPairSync } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const PEM = join(ROOT, ".clare-update-key.pem");
const CONFIG = join(ROOT, "clare.config.json");

if (!existsSync(PEM)) {
  const { privateKey } = generateKeyPairSync("ed25519");
  writeFileSync(PEM, privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600 });
}
const jwk = createPublicKey(createPrivateKey(readFileSync(PEM))).export({ format: "jwk" });
const updateKey = Buffer.from(jwk.x, "base64url").toString("base64");
const config = JSON.parse(readFileSync(CONFIG, "utf8"));
if (config.updateKey !== updateKey) {
  config.updateKey = updateKey;
  writeFileSync(CONFIG, JSON.stringify(config, null, 2) + "\n");
}
console.log(`✓ update key ${updateKey} (public half, in clare.config.json)`);
