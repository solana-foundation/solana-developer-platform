---
name: sdp-tokenization
description: Explain, plan, and prototype tokenization workflows on Solana Developer Platform using the supported public docs and API surface. Use when a consumer wants to issue a stablecoin, tokenized security, loyalty token, or other asset with SDP.
---

# SDP Tokenization

Use this skill when someone wants to understand how to tokenize an asset with Solana Developer Platform, map a business requirement to the right token model, or turn that plan into an SDP integration sequence.

## Scope

Stay on the supported public surface only:

- public docs under `apps/sdp-docs/content/docs/**`
- public API contract in `apps/sdp-api/src/openapi/**`

Do not rely on hidden or internal route families.

## Default workflow

1. Classify the asset and control model.
2. Load only the relevant public references from `references/tokenization-map.md`.
3. Recommend the right SDP template or custom configuration.
4. Explain the implementation sequence in order:
   - organization and wallet setup
   - API key scope and permissions
   - token creation
   - deployment
   - minting, transfers, and redemptions
   - allowlist, freeze, pause, and authority operations if needed
5. Call out operational constraints and authority ownership explicitly.

## Output shape

Default to these sections unless the user asks for something narrower:

- Asset type and operating model
- Recommended SDP template or token configuration
- Required wallets, authorities, and permissions
- Step-by-step implementation flow
- Relevant docs and endpoints
- Risks, compliance controls, and operational caveats

## Decision rules

- Recommend `stablecoin` for fiat-backed issuance with pause and delegated admin controls.
- Recommend `tokenized-security` for regulated assets that usually need allowlists and stronger compliance controls.
- Recommend `arcade` for closed-loop, loyalty, or gaming-style tokens.
- Recommend `custom` only when templates do not fit the issuance model.
- Prefer SDP-controlled custody wallets for mint, freeze, metadata, and other authorities by default.
- Treat external or multisig authorities as an advanced path and state that clearly.

## Operational guidance

- A token must be created before it can be deployed, and deployed before it can be minted or transferred.
- Amounts are usually submitted in smallest-unit token amounts, not UI-decimal strings.
- Burn, freeze, and similar account-level operations often require a token account address rather than a wallet address.
- If a token is paused, minting and transfer-related actions should be treated as unavailable until it is unpaused.
- If a workflow needs SDP to sign directly, recommend execute flows first; use prepare flows only when the signer needs to be external to SDP.

## When to open more references

- Open `references/tokenization-map.md` first for the public playbook.
- Open specific guides only for the steps actually relevant to the user.
- Open `apps/sdp-api/src/openapi/paths/issuance.ts` and `apps/sdp-api/src/openapi/paths/payments.ts` when the user needs endpoint-level mapping from committed source.

## Boundaries

- Do not promise legal or regulatory sufficiency; describe product controls and note where legal review is still needed.
- Do not invent unsupported issuance templates, custody modes, or hidden APIs.
- Do not recommend internal-only routes even if they exist in the codebase.
