# Solana Developer Platform

This file is the canonical agent guide for this repository.

## Repo layout

- `apps/sdp-api`: Node.js API deployed to Cloud Run, OpenAPI source, route handlers, Postgres/Redis integrations
- `apps/sdp-web`: dashboard application
- `apps/sdp-docs`: public documentation site and generated API reference
- `packages/sdp-types`: shared runtime types and shared product constants
- `packages/sdp-design-tokens`: shared design tokens (CSS custom properties, Tailwind theme mapping) and the `refresh` theme scope; see its README
- `packages/sdp-ui`: the dashboard's UI primitives (`@sdp/ui`) over `@solana/design-system` and the design tokens; `apps/sdp-web/src/components/ui/*` re-exports them; see its README

## Source of truth

- Public API contract: `apps/sdp-api/src/openapi/**`
- Public docs navigation: `apps/sdp-docs/content/docs/meta.json`
- Generated API docs: `apps/sdp-docs/content/docs/reference/api/**`
- AI discovery resources: `apps/sdp-docs/public/llms.txt` and `apps/sdp-docs/public/llms-full.txt`

## Generated files

Do not hand-edit generated artifacts. Regenerate them with the owning script.

- OpenAPI JSON: `pnpm -C apps/sdp-api openapi:generate`
- API playground catalog: `pnpm generate:api-playground`
- API reference docs: `pnpm -C apps/sdp-docs generate:api`
- AI discovery resources: `pnpm -C apps/sdp-docs generate:ai`

## Public vs internal surfaces

Public docs and AI artifacts should mirror the supported public surface only.

- Public API families are the ones the deployment's release channel runs (`SDP_RELEASE_CHANNEL`; prod runs `stable`, stage `beta`, dev `experimental`), so no deployment documents a route it refuses with 403. Every surface derives from the module stages in `packages/sdp-types/src/release-channels.ts` and the route inventory in `apps/sdp-api/src/routes/route-modules.ts`; never hand-maintain another list or move content to hide a module.
  - Public OpenAPI: `createPublicOpenApiDocument({ releaseChannel })` in `apps/sdp-api/src/openapi/spec.ts` drops other modules' routes, and `openapi/release-channel-values.ts` drops their enum values, examples and `oneOf` branches from shared schemas (classify a new permission, operation or wallet purpose there). The API serves `/openapi.json` and `/llms.txt` for its own channel at runtime.
  - Docs site, API reference, Postman and `llms*.txt`: the docs build reads `SDP_RELEASE_CHANNEL` (required on Vercel, set per environment like sdp-web; the Dockerfile build arg defaults to `experimental`). The API writes what the channel publishes (modules and ramp providers, Earn's hold included) to a manifest the docs build reads. Gates follow module declarations: a page about one module takes `module: <module>` frontmatter (or `rampProvider: <provider>`), shared pages never name a module, and lists of modules, providers or operations are generated blocks (see `apps/sdp-docs/CLAUDE.md`, "Release Channels"). Committed generated artifacts are built at `experimental` (an unset channel), so CI drift checks see every module; CI also checks links on `stable`.
  - API playground: the committed catalog holds every channel's operations with their module; the dashboard filters it, and the hand-authored forms, by its own channel.
- `earn` is held out of every public surface until launch (PRO-2038), independently of its release-channel stage: `EARN_PUBLIC_SURFACE_PUBLISHED` in `apps/sdp-api/src/openapi/spec.ts` drops the family from the public OpenAPI document, and the API reference, Postman collection, playground catalog and AI files regenerate from it. Flipping it back is a PRO-1872 security sign-off PR. The internal document and the runtime are unchanged, except `GET /v1/projects/{projectId}/provider-availability`, which omits Earn entries while the flag is false so the response matches the public document.
- Hidden/internal families stay out of public AI resources unless product policy changes: `rpc`, `admin`, `onboarding`, `auth`, `organizations`, `members`
- Earn has two access tiers. Only strategy catalogue reads, deposit and withdrawal previews, withdrawal-route discovery, and unsigned instant deposit/direct-withdrawal builds may be keyless. Queued request and cancellation builds, submits, tenant reads, programs, custody routes, and the aggregate movement feed always require authentication. Keep this matrix aligned across the router, the internal OpenAPI document and the Embedded Yield guide, which is unpublished until PRO-2038 and lives at `apps/sdp-docs/content/unpublished/guides/embedded-yield.mdx`, outside the built `content/docs` tree.
- Promoting a route into the public OpenAPI document is a security-relevant scope change, not a docs edit: the PR needs a named security sign-off. For `earn` the pinned list in `apps/sdp-api/src/openapi/spec.test.ts` enforces this (see `apps/sdp-api/src/routes/earn/CLAUDE.md`, "Public OpenAPI promotion").

## Preferred checks

- Docs integrity: `pnpm --filter sdp-docs check:links`
- Docs build: `pnpm --filter sdp-docs build`
- Module boundaries: `pnpm check:module-boundaries`
- API playground drift: `pnpm check:api-playground`
- API typecheck: `pnpm --filter @sdp/api typecheck`
- API tests: `pnpm --filter @sdp/api test`
- Full workspace typecheck: `pnpm typecheck`

## Implementation guidance

- Follow `docs/contributing/code-standards.md` (correctness, concurrency, TypeScript, API, and dashboard rules). Reviews enforce it.
- Prefer reusing generated docs/OpenAPI metadata instead of duplicating route inventories by hand.
- Implement each optional-auth Earn endpoint once. A valid credential enriches that request with tenant context and retains its previous permission requirement; an anonymous request must never acquire tenant identity or persist a build, advisory, movement, or position row.
- Never downgrade a presented Earn credential to anonymous access. Invalid or expired API keys, plus Clerk tokens without organization context, return 401.
- Keep public URLs coherent with the shared site constants in `@sdp/types/site`.
- When changing docs URLs or discovery resources, update both the docs site and any product links that point at it.
- Update `docs/architecture/module-map.md` with `pnpm generate:module-map`; do not edit it by hand.
- A new env key the API reads goes in `apps/sdp-api/src/types/env.d.ts`, `scripts/secret-keys.mjs` and
  `turbo.json` `globalEnv`: turbo drops undeclared keys, so without the last two the local API never sees it.
- **Migrations run while the previous revision still serves traffic.** `pnpm check:migration-compat`
  rejects one the previous image cannot run against and common DDL that holds a blocking lock on an
  existing table: build an index `CONCURRENTLY`, alone in a `-- sdp:migration-mode: non-transactional`
  file, and add a foreign key `NOT VALID`, validated in a later migration. Rules and what it misses:
  `docs/ops/release-operations.md`, "Schema compatibility".
- Consume Solana Earn packages only through exact registry-backed versions or the exact-version pnpm
  catalog. Do not commit cross-repository workspace, link, file, Git, or URL dependencies; see
  `docs/architecture/solana-earn-consumption.md`.
- **Money moves only through the signing waists (ADR 0007).** Get a custody signer from
  `createOrgSignerForCustodyWallet` and a sponsor from `createSponsorshipFeePayment` (or its
  wrappers), passing the movement from `MOVEMENTS` in `@sdp/types`; never build a signing adapter
  or fee payer yourself (`pnpm check:value-movement` enforces it). Marking a movement `exit` is a
  security-reviewed change.
- **RPC is a budget (hard rule).** Every provider read, quote and build makes the fewest RPC calls
  that still read every value-bearing input live: no per-call client construction or re-validation,
  no account fetched twice in one operation, static facts cached with a TTL that never stores a
  failure, independent accounts batched, identical concurrent reads shared, no unfiltered
  `getProgramAccounts`, no round trip whose answer is unused. A change to one of those paths states
  its before/after request count. Full checklist: `packages/sdp-earn/CLAUDE.md`, "RPC budget".

## Repo-local skills

- `skills/sdp-tokenization/SKILL.md`: consumer-facing skill for explaining how to tokenize assets with SDP using the supported public docs and API surface.
- `.agents/skills/sdp-ui-designer/SKILL.md`: SDP UI design skill for designing, prototyping, reviewing, or implementing payments, wallets, counterparty, and issuance UI. Its bundle ships the canonical token reference (`sdp-design-system.css`) and the UI handoff rules (`AGENTS.md`) alongside the skill; treat those as the design source of truth for UI work.
- `.agents/skills/integrate-ramp-provider/SKILL.md`: explicit-only Payments/Ramps integration router; its sibling skills cover provider registration, rail discovery, estimates, counterparty requirements, on-ramp, off-ramp, and webhooks.
- `.agents/skills/sdp-concise/SKILL.md`: explicit-only, action-first output contract shared by SDP workflows.
- `.agents/skills/sdp-make-pr/SKILL.md`: explicit-only PR creation workflow with technical before/after behavior, flows or pseudocode, verification, and risk notes.
- `.agents/skills/sdp-review/SKILL.md`: explicit-only SDP change-set digest and focused review workflow.
- `.agents/skills/sdp-bug-report/SKILL.md`: explicit-only SDP bug-bash reporting workflow for Linear issue `PRO-1482`.

When updating repo-local skills:

- keep them grounded in the public docs and API reference instead of internal handlers
- prefer concise `SKILL.md` files with deeper material moved into `references/`
- expose new skills from this file so they remain discoverable through the repo's AI entry point
