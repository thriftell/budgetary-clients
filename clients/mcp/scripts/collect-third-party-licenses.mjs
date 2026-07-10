#!/usr/bin/env node
// Aggregate the license texts of every THIRD-PARTY package esbuild actually
// bundled into dist/ and write them to dist/THIRD-PARTY-NOTICES.txt (shipped via
// `files: ["dist"]`). The filename is NOTICES, not LICENSES, on purpose — see the
// NOTE next to the write below. Bundling copies these packages' source into the published
// artifact, and MIT/BSD/ISC/Apache all require their copyright + permission
// notice to travel with the copy — this file is that notice.
//
// The set is derived from the esbuild metafile (tsup `metafile: true`), so it is
// exact and self-updating: add or drop a bundled dependency and this list tracks
// it. First-party `@budgetary/*` packages are excluded (same repo, same license);
// `@budgetary/sdk` is external anyway. Node built-ins never appear here.
//
// Fails the build (non-zero exit) if a bundled third-party package has no
// discoverable license file — silently shipping unlicensed copies is not allowed.

import {
  existsSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

const cwd = process.cwd();
const distDir = join(cwd, "dist");

// tsup writes metafile-<format>.json into the out dir; take whatever is there.
const metafileName = readdirSync(distDir).find(
  (f) => f.startsWith("metafile-") && f.endsWith(".json"),
);
if (!metafileName) {
  console.error(
    "collect-third-party-licenses: no dist/metafile-*.json found — did tsup run with metafile:true?",
  );
  process.exit(1);
}
const metafile = JSON.parse(readFileSync(join(distDir, metafileName), "utf8"));

// Map each bundled input under node_modules to its owning package directory.
// pnpm nests as .../node_modules/.pnpm/<pkg>@<ver>/node_modules/<pkg>/...; the
// LAST `/node_modules/` segment names the real package (handles scopes).
const pkgDirs = new Map(); // "name" -> absolute package dir
for (const input of Object.keys(metafile.inputs ?? {})) {
  const marker = input.lastIndexOf("/node_modules/");
  if (marker === -1) continue;
  const after = input.slice(marker + "/node_modules/".length);
  const parts = after.split("/");
  const name = after.startsWith("@") ? `${parts[0]}/${parts[1]}` : parts[0];
  if (!name || name.startsWith("@budgetary/")) continue; // first-party: skip
  const dir = join(cwd, input.slice(0, marker), "node_modules", name);
  if (!pkgDirs.has(name)) pkgDirs.set(name, dir);
}

const LICENSE_FILES = [
  "LICENSE",
  "LICENSE.md",
  "LICENSE.txt",
  "LICENCE",
  "LICENCE.md",
  "LICENSE-MIT",
  "license",
  "license.md",
];

function readLicenseText(dir) {
  if (!existsSync(dir)) return null;
  for (const f of LICENSE_FILES) {
    const p = join(dir, f);
    if (existsSync(p)) return readFileSync(p, "utf8").trimEnd();
  }
  // Some packages inline the license only in a README; fall back to none.
  return null;
}

const names = [...pkgDirs.keys()].sort();
const missing = [];
const sections = [];
for (const name of names) {
  const dir = pkgDirs.get(name);
  let version = "";
  let licenseId = "";
  try {
    const pj = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
    version = pj.version ?? "";
    licenseId =
      typeof pj.license === "string" ? pj.license : (pj.license?.type ?? "");
  } catch {
    /* fall through — reported as missing below if no text either */
  }
  const text = readLicenseText(dir);
  if (!text) {
    missing.push(name);
    continue;
  }
  const header = `${name}@${version}${licenseId ? ` (${licenseId})` : ""}`;
  sections.push(
    `${"=".repeat(78)}\n${header}\n${"=".repeat(78)}\n\n${text}\n`,
  );
}

if (missing.length > 0) {
  console.error(
    "collect-third-party-licenses: no license file found for bundled package(s): " +
      missing.join(", ") +
      "\nAdd handling (or vendor the notice) before publishing.",
  );
  process.exit(1);
}

const preamble =
  "Budgetary MCP server — third-party license notices\n\n" +
  "This package is a bundle. The following third-party packages are compiled\n" +
  "into dist/ and are distributed under their own licenses, reproduced below.\n" +
  "@budgetary/sdk is a separate (external) runtime dependency and is not bundled.\n\n";

// NOTE: the filename must NOT match pnpm's license glob (`licen[cs]e*`), or
// pnpm's `pack` treats the package as already carrying a license and skips
// copying the repo-root Apache-2.0 LICENSE into the tarball. "NOTICES" is safe.
writeFileSync(
  join(distDir, "THIRD-PARTY-NOTICES.txt"),
  preamble + sections.join("\n"),
  "utf8",
);
// The metafile is a build-time artifact (it leaks the local node_modules
// layout); drop it so it never ships in the tarball.
rmSync(join(distDir, metafileName), { force: true });
console.log(
  `collect-third-party-licenses: wrote notices for ${names.length} bundled package(s): ${names.join(", ")}`,
);
