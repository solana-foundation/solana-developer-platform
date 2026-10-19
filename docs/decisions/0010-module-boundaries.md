# 0010. Module boundaries

Date: 2026-10-18
Status: Proposed (HOO-2136). Numbers from a one-off knip 6.41.0 audit run outside the tree.

## Context

`apps/sdp-api` has 60 `index.ts` files that mostly re-export. Their callers follow no single
convention:

| Barrel | Callers via barrel | Callers importing the file directly |
|---|---|---|
| `db/repositories/index.ts` (85 re-export lines) | 85 | 70 |
| `middleware/index.ts` | 0 | 136 |
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
3. **Enforcement is Biome**, already in CI. Each rule turns on in the PR whose sweep makes it pass:
   `style/noDefaultExport` (#2403, with an `overrides` block for the exceptions above);
   `performance/noBarrelFile`, `performance/noReExportAll` and `style/noExportedImports` (#2404).
   No new tool.
4. **No dead-code tool in the repo.** knip was a one-off audit (`pnpm dlx knip`, config kept
   outside the tree). Without barrels, an unused export is a plain grep, and Biome's
   `noUnusedImports` / `noUnusedVariables` already cover the file-local half.

## Module boundaries

Four layers decide what a module may import. A boundary goes in the lowest layer that can express
it. A higher layer only narrows what a lower one allows (which files inside the owning package
may use it); restating a lower layer's boundary adds config and no protection.

| Layer | Question | Mechanism |
|---|---|---|
| Dependencies | Which workspaces may use a package at all | The importing workspace's `package.json` declares it. pnpm links only declared dependencies, so an undeclared package fails in `tsc` and at runtime. The repo root's dependencies resolve from every workspace, so the root declares only tooling. |
| Package surface | What a workspace package offers | Its `package.json` `exports` list. An unlisted file does not resolve through the package name. A tsconfig `paths` entry into another workspace's source bypasses the list; `sdp-api-integration`, which tests the API from outside, is the one workspace with such entries. |
| Callers | Which files may import an exported subpath | `style/noRestrictedImports` today; one Biome GritQL plugin per boundary as each module is narrowed (below). |
| Capabilities | Which files may turn key material into signing authority | `pnpm check:value-movement` allowlists (`0007-money-admission.md`). Adding a file is a security-reviewed change. |

A third-party SDK that one package wraps is declared only by that package, never by the root, and
the declaration is the boundary: no lint rule restates it.

Narrowing a module, applied to every module in turn:

1. **One capability per exported subpath.** A capability with fewer legitimate callers than the
   rest of its module moves to its own file and `exports` entry, so its boundary is a whole
   subpath, never a list of import names. Helius DAS already has its own subpath; opening a
   cluster scope and the history RPC pool still share one with their widely used siblings.
2. **One plugin per boundary.** A `.grit` file listed in `biome.json` `plugins` matches imports of
   that subpath and fails unless `$filename` is on its allowlist. The allowlist names the files,
   tests included, and the plugin's message names the reason and the ADR. Each plugin stands
   alone: adding or widening one never touches another.
3. **Exceptions live in the plugin's allowlist**, reviewed in one place; no `biome-ignore` for a
   boundary.

Why not `style/noRestrictedImports`: Biome override options replace each other rather than merge,
so every override that relaxes one entry restates all the others, and a file excluded from an
override loses every entry. The rule stays for blanket bans that apply to every file in their
scope; its per-caller entries (the `@sdp/rpc` subpaths, the release-channel lists) move to plugins
as each module is narrowed.

## Consequences

- One-time sweep: 43 Hono `export default app` files in `apps/sdp-api` become named exports; 2
  non-framework default exports in `apps/sdp-web`; 1055 bare `@sdp/types` imports and ~130 other
  bare `@sdp/*` imports move to subpaths; every `index.ts` that only re-exports is deleted (#2404
  in `apps/sdp-api`, #2406 in packages) with callers rewritten to the defining file, and the ones
  left define code. Mechanical: codemod resolves each imported symbol to its defining file.
- Route modules keep an `index.ts` only if it defines the Hono app itself (a mount file, not a
  barrel).
- `docs/contributing/code-standards.md` gains one TypeScript rule, "Imports name the defining
  file"; Greptile inherits it through `.greptile/rules.md`, which flags code-standards violations.
- Zero users, so no transition period.
