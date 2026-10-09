#!/usr/bin/env node
// Compares pack-config.js (frontend) against supabase/functions/_shared/packs.ts
// (backend) and fails if a pack's price or credit amount differs between them.
// See .github/workflows/pack-config-check.yml for why this exists.
import { readFileSync } from "node:fs";
import vm from "node:vm";

function loadFrontendPacks() {
  const src = readFileSync("pack-config.js", "utf8");
  const sandbox = { window: {} };
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox, { filename: "pack-config.js" });
  const packs = sandbox.window.AETHYRO_PACKS;
  if (!Array.isArray(packs)) {
    throw new Error("pack-config.js did not define window.AETHYRO_PACKS as an array");
  }
  const byKey = {};
  for (const p of packs) {
    if (!p || typeof p.key !== "string") {
      throw new Error("pack-config.js has an AETHYRO_PACKS entry with no string 'key'");
    }
    byKey[p.key] = { price: p.price, credits: p.credits };
  }
  return byKey;
}

function loadBackendPacks() {
  let src = readFileSync("supabase/functions/_shared/packs.ts", "utf8");
  // Strip TS-only syntax so plain Node can evaluate the object literal.
  src = src.replace(/export interface CreditPack\s*\{[^}]*\}\n?/s, "");
  // `var`, not `const` -- a bare top-level `const`/`let` run via
  // vm.runInContext creates a lexical binding, not a property on the
  // context object, so it would never be readable back as sandbox.CREDIT_PACKS.
  src = src.replace(
    /export const CREDIT_PACKS\s*:\s*Record<string,\s*CreditPack>\s*=/,
    "var CREDIT_PACKS =",
  );
  if (!/var CREDIT_PACKS =/.test(src)) {
    throw new Error(
      "could not find 'export const CREDIT_PACKS: Record<string, CreditPack> = ...' in " +
        "_shared/packs.ts -- did its declaration shape change? Update check-pack-config.mjs " +
        "to match.",
    );
  }
  const sandbox = {};
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox, { filename: "_shared/packs.ts" });
  const packs = sandbox.CREDIT_PACKS;
  if (!packs || typeof packs !== "object") {
    throw new Error("_shared/packs.ts did not define CREDIT_PACKS as an object");
  }
  const byKey = {};
  for (const [key, p] of Object.entries(packs)) {
    byKey[key] = { price: p.cents / 100, credits: p.credits };
  }
  return byKey;
}

function main() {
  const frontend = loadFrontendPacks();
  const backend = loadBackendPacks();

  const allKeys = new Set([...Object.keys(frontend), ...Object.keys(backend)]);
  const errors = [];

  for (const key of allKeys) {
    const f = frontend[key];
    const b = backend[key];
    if (!f) {
      errors.push(`"${key}" exists in _shared/packs.ts but not in pack-config.js`);
      continue;
    }
    if (!b) {
      errors.push(`"${key}" exists in pack-config.js but not in _shared/packs.ts`);
      continue;
    }
    if (f.price !== b.price) {
      errors.push(
        `"${key}" price mismatch: pack-config.js says $${f.price}, ` +
          `_shared/packs.ts says $${b.price} (${b.credits === f.credits ? "" : "and "}` +
          `cents=${b.price * 100})`,
      );
    }
    if (f.credits !== b.credits) {
      errors.push(
        `"${key}" credits mismatch: pack-config.js says ${f.credits}, ` +
          `_shared/packs.ts says ${b.credits}`,
      );
    }
  }

  if (errors.length > 0) {
    console.error("Pack config drift detected between pack-config.js and _shared/packs.ts:\n");
    for (const e of errors) console.error("  - " + e);
    console.error(
      "\nBoth files must describe the same packs. If you changed a price or credit " +
        "amount, update it in both files (and remember: Stripe Prices are immutable, so a " +
        "real price change also needs a new Stripe Price and a new priceId in _shared/packs.ts).",
    );
    process.exit(1);
  }

  console.log(`OK: ${allKeys.size} packs match between pack-config.js and _shared/packs.ts.`);
}

main();
