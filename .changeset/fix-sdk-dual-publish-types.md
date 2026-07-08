---
"@budgetary/sdk": patch
---

Fix the dual-published CommonJS type declarations. The CJS build now emits its own `.d.ts` (`tsconfig.cjs.json` `declaration: true`), and the package `exports` map carries per-condition types — `import` and `require` each point at the matching ESM / CJS declarations — with `main` and `types` now pointing at the CJS entry. A CommonJS TypeScript consumer on `moduleResolution: node16` / `nodenext` no longer hits **TS1479** from the ESM `.d.ts` masquerading as CommonJS. CI now runs `@arethetypeswrong/cli` against the packed tarball, so the exports map can't silently regress.
