# ADR 0001: Asset Profile data model

- **Status:** Proposed
- **Date:** 2026-06-17
- **Deciders:** Issuance team
- **PRD:** [Issuance Asset PRD [Draft]](https://app.notion.com/p/solanafoundation/Issuance-Asset-PRD-Draft-379d36dad52d81e684ffd3634ba81486)
- **Related:** migration `apps/sdp-api/src/db/migrations/postgres/0013_asset_profiles.sql`

## Context

SDP can deploy Token-2022 tokens but has no SDP-owned model for *what an issued
token represents as an asset* (a stablecoin, a tokenized security, etc.). The
Issuance Asset PRD introduces the **Asset Profile**: a record that groups a token
into an Asset Category, identifies its Asset Type, holds canonical Issuance
Metadata, and serves a safe public subset through the token metadata URI.

We need a data model that:

- attaches asset identity + metadata to an already-issued token,
- keeps private (compliance, customer) metadata separate from public metadata,
- lets us add new categories/asset types **without migrations**,
- matches the conventions already proven by counterparty management.

The PRD's "rough technical direction" is explicit: supported categories/types are
defined in code, token-specific data lives in the DB, flexible metadata is JSONB,
and the application layer controls validation and projection.

## Decision

### 1. One `asset_profiles` table, 1:1 with `issued_tokens`

A profile is an extension of an existing issued token, not a standalone entity.
We add a single `asset_profiles` table scoped to `(organization_id, project_id)`
with a composite FK to `issued_tokens(id, organization_id, project_id)` — mirroring
how `counterparty_accounts` FKs into `counterparties`. This guarantees a profile
can never reference a token in another org/project.

### 2. The registry of valid categories/types lives in code, not the DB

`asset_category`, `asset_type`, and `asset_type_version` are stored as open
`TEXT`/`INTEGER` with **no CHECK constraint**. Allowed values, category↔type
consistency, metadata validation, public-projection rules, and lifecycle gates
are all defined in the **Asset Type Registry** in `@sdp/types`
(`ASSET_CATEGORIES`, `ASSET_TYPES`, registry entries), enforced at the
application layer via Zod. This is the same "open TEXT + app-layer enum" pattern
used for `counterparty_accounts.account_kind`.

Consequence: adding `tokenized_security` asset types, or a whole new category,
is a code change with no migration. We explicitly do **not** build a DB-managed
asset-type configuration product (out of scope per the PRD).

### 3. Two JSONB columns: private master + cached public projection

- `issuance_metadata JSONB` — the full, private canonical record. Shape:
  `{ asset, compliance, chain, custom: { customer, integration } }`.
  `custom.customer` / `custom.integration` are namespaced so customer and
  integration fields never collide with SDP-defined fields. Validated with a
  strict schema on known namespaces and `z.looseObject` on `custom.*`.
- `public_metadata JSONB` — the safe subset served to wallets/explorers.

Both carry a `CHECK (jsonb_typeof(col) = 'object')` constraint, matching the
counterparty JSONB columns.

### 4. `public_metadata` is a cached column, recomputed on write

The public token metadata URI endpoint returns `public_metadata` **verbatim**
and never reads `issuance_metadata`. On every create/update we recompute
`public_metadata` by applying the registry's projection rules to
`issuance_metadata`. This makes the public, unauthenticated URI a cheap single-row
read and makes leakage structurally impossible: private `compliance` and
`custom.*` fields are never in the column the public endpoint reads.

Precedent: `issued_tokens.total_supply_cached` already caches a derived value for
read performance.

### 5. One active profile per token, enforced by a partial unique index

`CREATE UNIQUE INDEX ... ON asset_profiles(token_id) WHERE status = 'active'`.
Archival is a soft delete (`status = 'archived'`), matching the counterparty
pattern, and an archived profile can coexist with a new active one.

### 6. A profile is created together with its token, in one transaction

There is no "create profile for an existing token" endpoint. A token and its
profile are created by a single request, `POST /v1/issuance/asset-profiles`,
which writes the `issued_tokens` row and the `asset_profiles` row inside one DB
transaction: if either write fails, both roll back. This makes "every issued
token has a profile" an invariant established at creation rather than a
follow-up call a client might skip, and removes the standalone-create
concurrency window (a fresh, globally unique `token_id` is minted per request,
so two concurrent creates can never contend for the same token's active-profile
slot). The profile still conceptually *extends* a token (Section 1); it is just
never born separately. The asset-profile resource lives under the issuance
namespace (`/v1/issuance/asset-profiles`, a sibling of `/v1/issuance/tokens`);
reads, updates, and archival are its `GET`/`PATCH`/`DELETE` operations.

## Alternatives considered

- **Compute the public projection on every URI read** instead of caching.
  Simpler and always consistent, but adds latency and recomputes registry rules
  on every (unauthenticated, potentially hot) request. Rejected in favor of the
  cached column; the cache is rebuilt deterministically on each write.
- **Allow profile history (multiple versions per token).** Would mean dropping
  the unique index and adding a version/supersedes chain. Rejected for v1 — we
  keep the 1:1 constraint now and can relax it later if versioned profiles are
  needed. `asset_type_version` already lets the *registry shape* evolve without
  needing row history.
- **Separate `asset_categories` / `asset_types` tables.** This is the
  DB-managed configuration product the PRD puts out of scope. Rejected; the
  registry is code.
- **Reuse `issued_tokens.uri` / existing token metadata fields.** Those are
  deploy-time token fields; conflating them with lifecycle asset metadata is the
  exact "blurred metadata surfaces" problem the PRD calls out. Rejected.

## Consequences

- New asset types/categories ship without migrations; only `@sdp/types` and
  validation change.
- Public exposure is allow-list driven by projection rules and physically
  separated into its own column — private-by-default holds even if a projection
  rule is buggy, because nothing auto-flows into `public_metadata`.
- The public URI endpoint must be mounted on a router **without** auth
  middleware and must read only `public_metadata`.
- The 1:1 constraint means re-profiling a token is archive-then-create, not
  in-place replace, if we ever want to preserve the prior profile.
- Migration `0013` adds a composite unique constraint to `issued_tokens`; it is
  idempotent (`DO $$ ... IF NOT EXISTS`) and safe to run on existing data.

## Follow-ups (tracked, not decided here)

- Minimum public projection per category (PRD open question).
- Which metadata fields are required before create/deploy/mainnet (lifecycle
  gates in the registry).
- How chain-enriched `chain.*` metadata is refreshed and surfaced.
- Whether external (non-SDP-hosted) token metadata URIs are an allowed override.
