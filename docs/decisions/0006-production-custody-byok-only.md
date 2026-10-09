# ADR 0006: Production custody is BYOK only, and custody is project-scoped

- **Status:** Proposed
- **Date:** 2026-10-08
- **Deciders:** SDP engineering
- **Related:** ADR 0005 (release channels); `packages/sdp-types/src/custody.ts`; `packages/sdp-types/src/release-channels.ts`

## Context

Custody has two modes, fixed per wallet: Managed (the deployment's own provider account) and BYOK (a provider account the project supplied). Nothing ties a mode to a project's environment, so a Production project can hold Managed wallets, either its own or an org-level config's reached through the project-to-org fallback. BYOK is switched on deployment-wide by one env flag, Privy only.

## Decision

- A Production project may use BYOK only; a Sandbox project may use both. SDP's hosted deployment never holds mainnet keys under its own provider accounts.
- Custody is set up per project only. Org-level custody configs and every project-to-org fallback are removed.
- Which (provider, mode) pairs a deployment offers is set by its release channel, with one stage map per mode, extending ADR 0005. This replaces `PRIVY_BYOK_ENABLED`.
- A Production project uses only providers whose stage is `stable`, in every provider family, whatever the deployment's channel. The API enforces this, and a public project-scoped availability read reports it.

## Considered Options

- **Merge Managed into `custody_connections` (one table, mode derived from credential source)**: rejected for now. It needs connection adapters for nine providers and a rewrite of wallet ownership, and production gating doesn't require it. The owning table is the mode.
- **Treat a self-hosted operator's env credentials as BYOK**: rejected. Mode follows where the credentials come from (deployment configuration = Managed), so the production rule needs no deployment-mode branch.
- **Check the environment on every signature**: rejected in favour of a gate wherever custody gets set up, plus a DB backstop. Wallets pin their backend, so with the fallbacks gone a non-conforming row can't exist.
