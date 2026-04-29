# Solana Developer Platform

This file is the canonical agent guide for this repository.

## Repo layout

- `apps/sdp-api`: Cloudflare Workers API, OpenAPI source, route handlers, Postgres/KV integrations
- `apps/sdp-web`: dashboard application
- `apps/sdp-docs`: public documentation site and generated API reference
- `packages/sdp-types`: shared runtime types and shared product constants

## Source of truth

- Public API contract: `apps/sdp-api/src/openapi/**`
- Public docs navigation: `apps/sdp-docs/content/docs/meta.json`
- Generated API docs: `apps/sdp-docs/content/docs/reference/api/**`
- AI discovery resources: `apps/sdp-docs/public/llms.txt` and `apps/sdp-docs/public/llms-full.txt`

## Generated files

Do not hand-edit generated artifacts. Regenerate them with the owning script.

- OpenAPI JSON: `pnpm -C apps/sdp-api openapi:generate`
- API reference docs: `pnpm -C apps/sdp-docs generate:api`
- AI discovery resources: `pnpm -C apps/sdp-docs generate:ai`

## Public vs internal surfaces

Public docs and AI artifacts should mirror the supported public surface only.

- Public API families: `health`, `api-keys`, `wallets`, `projects`, `issuance`, `payments`, `compliance`
- Hidden/internal families stay out of public AI resources unless product policy changes: `rpc`, `admin`, `onboarding`, `auth`, `organizations`, `members`

## Preferred checks

- Docs integrity: `pnpm --filter sdp-docs check:links`
- Docs build: `pnpm --filter sdp-docs build`
- API typecheck: `pnpm --filter @sdp/api typecheck`
- API tests: `pnpm --filter @sdp/api test`
- Full workspace typecheck: `pnpm typecheck`

## Implementation guidance

- Prefer reusing generated docs/OpenAPI metadata instead of duplicating route inventories by hand.
- Keep public URLs coherent with the shared site constants in `@sdp/types/site`.
- When changing docs URLs or discovery resources, update both the docs site and any product links that point at it.

## Repo-local skills

- `skills/sdp-tokenization/SKILL.md`: consumer-facing skill for explaining how to tokenize assets with SDP using the supported public docs and API surface.

When updating repo-local skills:

- keep them grounded in the public docs and API reference instead of internal handlers
- prefer concise `SKILL.md` files with deeper material moved into `references/`
- expose new skills from this file so they remain discoverable through the repo's AI entry point
