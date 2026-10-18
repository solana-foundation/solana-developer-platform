# 0010. No barrel files, no default exports

Date: 2026-10-18
Status: Proposed (HOO-2136 step 1). Draft; numbers from the knip 6.41.0 baseline in
`docs/_devlog/HOO-2136/01-dead-code-baseline.md`.

## Context

`apps/sdp-api` has 60 `index.ts` files that mostly re-export. Their callers follow no single
convention:

| Barrel | Callers via barrel | Callers importing the file directly |
|---|---|---|
| `db/repositories/index.ts` (85 re-export lines) | 85 | 70 |
| `middleware/index.ts` | 2 | 137 |
| `services/domain/index.ts` | 0 | 26 |
| `services/solana/index.ts` | 19 | 4 |

A split convention grows without bound: an agent adding a repository sees half the callers import
the barrel and adds a re-export line; nobody removes one, because removal means proving no caller
needs it. The repositories barrel was touched by 36 commits in 90 days and carries 47 re-exports
no caller imports through it. Two barrels are dead outright.

Barrels also defeat static analysis. A symbol re-exported by a barrel reads as used to a human and
to most tools; only a reachability analysis (knip) sees through it. `export default` has the same
effect on grep and rename: the importer chooses the name, so one symbol has as many names as
importers.

Packages already expose subpaths through `package.json` `exports` (`@sdp/types` has 26), yet 1055
files import bare `@sdp/types` through its 38-line `src/index.ts`.

## Decision

1. **No barrel files.** A file exports only what it defines. No `export * from`, no
   `export { x } from` in `apps/*` or `packages/*/src`. A package's public surface is its
   `package.json` `exports` map pointing at real files; `src/index.ts` entry barrels go away and
   callers import the subpath.
2. **No default exports**, except where the framework reads the file by convention: Next.js
   special files (`page`, `layout`, `loading`, `error`, `not-found`, `template`, `default`,
   `global-error`, `opengraph-image`, `twitter-image`, `sitemap`, `robots`, `manifest`,
   `middleware`, `proxy`, `instrumentation`) and tool config files at a workspace root
   (`next.config`, `vitest.config`, `playwright.config`, `postcss.config`).
3. **Enforcement is Biome**, already in CI: `performance/noBarrelFile`, `performance/noReExportAll`,
   `style/noDefaultExport`, with an `overrides` block for the exceptions above. No new tool.
4. **No dead-code tool in the repo.** knip was a one-off audit (`pnpm dlx knip`, config kept
   outside the tree). Without barrels, an unused export is a plain grep, and Biome's
   `noUnusedImports` / `noUnusedVariables` already cover the file-local half.

## Consequences

- One-time sweep: 43 Hono `export default app` files in `apps/sdp-api` become named exports; 2
  non-framework default exports in `apps/sdp-web`; 1055 bare `@sdp/types` imports and ~130 other
  bare `@sdp/*` imports move to subpaths; 60 `index.ts` barrels in `apps/sdp-api` are deleted
  with callers rewritten to the defining file. Mechanical: codemod resolves each imported symbol
  to its defining file.
- Route modules keep an `index.ts` only if it defines the Hono app itself (a mount file, not a
  barrel).
- `docs/contributing/code-standards.md` gains the two rules under TypeScript; Greptile inherits
  them through the existing "flag code-standards violations" rule.
- Zero users, so no transition period.
