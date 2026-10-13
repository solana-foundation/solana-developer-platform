# ADR 0008: Ramp provider contract v2

- **Status:** Proposed
- **Date:** 2026-10-13
- **Deciders:** SDP engineering
- **Related:** HOO-2031, HOO-2026; `packages/sdp-payments/src/ramps`; ADR 0002 (Earn provider pluggability), ADR 0005 (release channels), ADR 0007 (cluster scope); PRO-2065, PRO-2057, PRO-2058; HOO-2032, HOO-2038, HOO-2040

## Context

Ramps launch with Stripe and MoonPay. Mural, MoneyGram and Lightspark are
removed; Coinbase (HOO-2035) and BVNK (HOO-2037) are next. Adding a provider
touches about 45 files today, 68 for one with KYC. The target is about 14.

`RampProvider` covers estimates, quotes and a synchronous counterparty check.
Everything else is a per-provider switch outside it, and the covered half is
bypassed:

- `RAMP_PROVIDER_CLIENTS` is `as const satisfies`, so callers keep the concrete
  client types. Routes call methods that are not on the contract; today every
  such call is BVNK's.
- Members use method syntax, which TypeScript checks bivariantly, so an
  implementation can narrow its inputs unnoticed.
- Core types import provider modules (BVNK compliance input, Stripe customer
  info).
- `providerFetchJson` casts provider JSON to a free type parameter. Nothing
  checks a response against what the adapter reads.
- A provider's error text becomes `SdpPaymentsError.message`, which the API
  returns in error bodies and writes to transfer rows.
- No test iterates the registry.

Before deleting BVNK and Lightspark, the BVNK owner asked whether headless,
stateful providers fit the model at all.

## Decision

- **Evolve `RampProvider` in place.** No plugin framework; Earn's in-place
  contract (ADR 0002) is the precedent.
  - Members are function-typed, so implementations are checked strictly.
  - Direction members are optional. `supportsRampDirection` reads member
    presence, so an onramp-only provider stops carrying an offramp method that
    throws.
  - `RampRuntimeContext` is `{ mode, cluster, credentials }`. Adapters never see
    the process environment. Credentials resolve per project for the resolved
    mode (HOO-2032); the cluster comes from the cluster scope (ADR 0007).
  - `RampQuoteRequest` and `RampQuoteResult` are provider-neutral and build on
    PRO-2065's `quoteDetails` and `paymentInstructions`. Core types import no
    provider module and name no provider field.
  - `RampQuoteResult` carries the terms the provider reported. One shared
    assertion checks them against the request (Lightspark's quote-matches-request
    check, generalized).
  - Optional members: `webhook` (signature descriptor, `eventId`, a pure `parse`;
    HOO-2038), `fetchTransferStatus` (HOO-2040) and `checkConnection`
    (HOO-1942, HOO-1943).
- **The registry is typed as the contract:**
  `Readonly<Record<LiveRampProviderId, RampProvider>>`.
  `resolveRampProviderClient` answers 503 for any id that is not live, retired
  ids included.
- **Provider responses are validated.** `providerFetchJson` takes a zod schema,
  and a response that does not match is `PROVIDER_UNAVAILABLE`. A schema
  requires exactly what the adapter reads, no more.
- **Error data is public or internal, never both.** `message` and `details` on
  `SdpPaymentsError` are public: error bodies and transfer rows carry them, so
  they hold only SDP's own wording. The provider's message, codes and field
  errors, and why a response was refused, go in `diagnostics`. The API logs
  them scrubbed as `error_diagnostics` and never serializes them: on
  `sdp_api_payments_provider_error` for failures the error handler answers,
  and on every log that catches a provider failure without rethrowing it,
  such as the estimate fan-out and the BVNK payout job. The shared
  vendor-call event stays name and code only (EARN-025).
- **One contract suite.** A single test iterates the registry. Every provider
  has a test kit of recorded HTTP transcripts, keyed by provider id, so a new
  provider fails typecheck until it has one. The suite covers estimate and
  quote shape per delivery mode, mode selection and a response that fails
  closed. Webhook verify and parse join with HOO-2038, idempotent replay with
  PRO-2058.
- **Boundary tests:** nothing outside the package imports a provider module,
  only `services/ramps` writes ramp rows, and `@sdp/payments` never sees `Env`.
- **Headless providers re-enter through this contract**, not a second extension
  point. A stateful provider like BVNK or Lightspark needs four things, each an
  optional member or port:
  - Requirements: an optional `requirements` member with async `describe` and
    `submit`, answering the existing `CounterpartyRequirements` union. The
    `/requirements` endpoint stays for API-first integrators.
  - Provider-side accounts: adapters return account records, and a store port in
    the core persists them as `counterparty_provider_accounts` rows (customer
    link, funding wallet, payout account). Adapters never touch the database.
  - Delivery: `manual_instructions` quotes carry the `fiat_funding` and
    `crypto_deposit` instruction kinds already in `@sdp/types`.
  - Settlement: the `webhook` member and `fetchTransferStatus`, through the same
    inbox and settlement guard as widget providers.

  None of it is built until a KYB or bank-payout provider returns.

## Considered Options

- **A plugin framework or capability registry:** rejected. Two launch providers
  do not need one, and Earn's in-place contract already works.
- **A quarantine package for the non-launch providers:** rejected. Only the
  adapter half can move; the route half needs Postgres and `Env`, scanners still
  see the code, and every contract change must be ported into it.
- **Keep the removed providers behind the release channel:** rejected. Every
  core step would carry them behind a legacy fence.
- **Validate responses in each adapter**, as BVNK's `parseBvnkResponse` does:
  rejected for the shared fetch, so no adapter can skip it.
- **Pass a sanitized provider snippet in the public message:** rejected. That is
  the leak this closes.

## Consequences

- Delivery is staged so no step edits route files the open cluster-scope stack
  (HOO-1873) also edits:
  1. This ADR, the error split and the diagnostics log.
  2. Response schemas and the contract suite.
  3. The contract reshaping and registry typing, after BVNK and Coinbase are
     removed and the cluster-scope stack lands. Credentials land with HOO-2032,
     the webhook member with HOO-2038, status pull with HOO-2040.
- Provider failures lose the provider's wording in API error bodies. Callers get
  the code, the provider status in `details` and an SDP message; operators read
  the provider's wording from `error_diagnostics` in the logs.
- Until step 3, BVNK and Coinbase stay on the current interface, named as legacy
  entries in the test-kit map.
- A schema stricter than the provider's real responses turns quotes into 503s,
  so schemas require only what adapters already read.
