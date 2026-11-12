// Fails the build if a tracked file that is not meant to be public would be
// served by the Worker (everything in the repo root is its asset directory;
// .assetsignore is the only thing that keeps files out of it).
//
// Two rules, both cheap to evaluate from `git ls-files` + .assetsignore:
//   1. Required-ignored: files that must never be served (project memory,
//      Supabase source/migrations/config, CI, tooling config, the Worker).
//   2. Unknown file types: any file that is NOT ignored must look like a web
//      asset (html/css/js/json/xml/txt/svg/images/fonts). A stray .py, .md,
//      .sql, .toml, .ts, .yml... added to the repo root fails here until it is
//      either added to .assetsignore or this allowlist is widened on purpose.
//
// .assetsignore is gitignore-style; this script supports the subset it uses:
// plain names, "*" globs, no negation, no leading-slash anchors. Anything else
// fails loudly instead of being silently misread.
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";

const patterns = readFileSync(".assetsignore", "utf8")
  .split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));

for (const p of patterns) {
  if (p.startsWith("!") || p.startsWith("/") || p.includes("/") || p.includes("**")) {
    console.error(`FAIL: unsupported .assetsignore pattern "${p}" (this check handles plain names and * globs only)`);
    process.exit(1);
  }
}
const regexes = patterns.map((p) => new RegExp("^" + p.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*") + "$"));
const ignored = (path) => path.split("/").some((seg) => regexes.some((re) => re.test(seg)));

const files = execSync("git ls-files", { encoding: "utf8" }).split("\n").filter(Boolean);

const REQUIRED_IGNORED = [
  "CLAUDE.md", "wrangler.jsonc", "worker.js", ".assetsignore", "CNAME",
  "supabase/config.toml", ".github/workflows/deploy-supabase.yml", ".claude/skills/probe/SKILL.md",
];
const SERVABLE = /\.(html|css|js|json|xml|txt|svg|png|jpe?g|gif|webp|ico|woff2?|webmanifest)$/i;
// Special files read by the platform, never served as content.
const PLATFORM_FILES = new Set(["_headers", "_redirects"]);

const problems = [];
for (const f of REQUIRED_IGNORED) {
  if (!ignored(f)) problems.push(`${f} would be publicly served; add a matching pattern to .assetsignore`);
}
for (const f of files) {
  if (ignored(f) || PLATFORM_FILES.has(f)) continue;
  if (!SERVABLE.test(f)) problems.push(`${f} is not ignored and is not a recognised web asset type; add it to .assetsignore or widen this allowlist on purpose`);
}

if (problems.length) {
  console.error("Public-surface check FAILED:\n  - " + problems.join("\n  - "));
  process.exit(1);
}
const served = files.filter((f) => !ignored(f) && !PLATFORM_FILES.has(f)).length;
console.log(`OK: ${served} tracked files are served, ${files.length - served} are ignored; all required-ignored files are covered.`);
