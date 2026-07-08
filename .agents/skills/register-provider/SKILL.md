---
name: register-provider
description: Scaffold and wire a new ramp provider into SDP so the platform knows it exists, dispatches to it, and gates it by availability. Add the id to RAMP_PROVIDERS, register the client, fill the dispatch switches, declare secrets, and stub the provider class. Step 1 — do this before the capability skills. Use when opening a PR against apps/sdp-api to add a ramp provider.
---

# Register a ramp provider

Step 1. This makes the platform *aware* of your provider and routes to it. The method bodies (estimate, quote, webhook, requirements, rails) are the other skills — here you build the skeleton and wire every dispatch site.

Canonical example to copy: **`apps/sdp-api/src/lib/ramps/providers/lightspark/client.ts`** (the class) + how it's referenced across the files below.

## The mantra: add the id, follow the compiler

Add your id to `RAMP_PROVIDERS` first, then run `tsc --noEmit`. The id is a closed union (`RampProviderId`), so the type checker now points at **every** site that must be wired. Fix each one — never add a fallback or a `default` branch to silence it.

```ts
// packages/sdp-types/src/provider-access.ts
export const RAMP_PROVIDERS = ["moonpay", "lightspark", "bvnk", "<id>"] as const;
```

Five sites break, in roughly this order:

| File | What's enforced | What you add |
|---|---|---|
| `lib/ramps/index.ts` | `RAMP_PROVIDER_CLIENTS` is `as const satisfies Record<RampProviderId, …>` | `<id>: new <Id>RampClient()` |
| `services/provider-availability.service.ts` | `ramps: Record<RampProviderId, ProviderAvailabilityDefinition>` | `<id>: { label, isConfigured }` |
| `routes/payments/handlers/ramps.ts` | quote, requirements, and (currently unused) execute switches end in `const _exhaustive: never` | a `case "<id>"` in each |
| `routes/webhooks/handlers.ts` | `RAMP_PROVIDER_WEBHOOK_PROCESSOR` is `as const satisfies Record<Exclude<RampProviderId, …>, WebhookProcessor<…>>` | `<id>: new <Id>WebhookProcessor()` (or extend the `Exclude` list if you skip webhooks) |
| `provider-access.ts` tier defaults | `createBooleanRecord(RAMP_PROVIDERS, …)` | (optional) add `<id>` to a tier's enabled list |

## The wiring

### 1. Provider id + entitlements — `provider-access.ts`
Add the id (above). Then decide default entitlement per tier — your provider is **disabled by default** unless you add it to the enabled list:

```ts
const ENTERPRISE_PROVIDER_DEFAULTS = {
  ramps: createBooleanRecord(RAMP_PROVIDERS, ["moonpay", "lightspark", "bvnk", "<id>"]),
  // …
};
```

### 2. Client registry — `lib/ramps/index.ts`
```ts
export const RAMP_PROVIDER_CLIENTS = {
  moonpay: new MoonpayRampClient(),
  lightspark: new LightsparkRampClient(),
  bvnk: new BvnkRampClient(),
  <id>: new <Id>RampClient(),
} as const satisfies Record<RampProviderId, RampProviderClient>;
```
`assertRampProviderRegistryComplete` also fails loudly at runtime if you miss this.

### 3. Availability — `services/provider-availability.service.ts`
Add an entry that reports whether the provider's secrets are present, for both modes. `isConfigured` returning false → the route returns HTTP 503 `PROVIDER_NOT_CONFIGURED`.

```ts
ramps: {
  // …
  <id>: {
    label: "<Provider>",
    isConfigured: (env, testMode) => {
      const prod = hasAllEnv(env, ["<PROVIDER>_KEY", "<PROVIDER>_SECRET"]);
      const sandbox = hasAllEnv(env, ["<PROVIDER>_SANDBOX_KEY", "<PROVIDER>_SANDBOX_SECRET"]);
      return testMode ? sandbox : prod;
    },
  },
},
```

### 4. Secrets — env vars on the `Env` type
The keys you reference in step 3 (and in your config reader) must exist on the `Env` type (`apps/sdp-api/src/types/env.ts`) and be provided as environment variables — both prod and `*_SANDBOX_*` sets. (This repo injects the real values via Doppler in deploy, not `wrangler.toml` / `.dev.vars`; a fork can supply them however its environment does — a missing one just surfaces as a 503.)

### 5. Dispatch — `routes/payments/handlers/ramps.ts`
Add a `case "<id>"` to each switch the compiler flags — the quote paths and `advanceCounterpartyRequirements`, plus the `executeOnramp`/`executeOfframp` switches. (Execute isn't currently exercised, but those switches still end in a `never` default, so add a case to compile.) The handler resolves DB state (counterparty, wallet, customer) and passes pre-resolved inputs to your client — the client never touches the DB. Provider-specific DB resolution that's too big to inline goes in `routes/payments/handlers/ramps/<id>.ts` (see `ramps/lightspark.ts`).

### 6. Webhook dispatch — `routes/webhooks/handlers.ts`
Add `<id>: new <Id>WebhookProcessor()` to the `RAMP_PROVIDER_WEBHOOK_PROCESSOR` map (or extend its `Exclude<RampProviderId, …>` if your provider has no webhooks). `parseRampWebhookProvider` accepts the id automatically once it's in that map. (Webhook *implementation*, including the `WebhookProcessor` class itself, is the `integrate-webhook` skill.)

## The provider class + config reader

Create `lib/ramps/providers/<id>/client.ts`:

```ts
export class <Id>RampClient implements RampProvider {
  readonly id = "<id>";
  // estimate*, createOfframpQuote, validateCounterparty, _discoverRails,
  // readRailSupport — bodies live in the capability skills.
}
```

Credentials are read from the passed `env`, keyed by `mode` — the provider never imports AppContext. The handler builds the `{ env, mode }` context with `rampRuntime(c)` (`routes/payments/context.ts`). Write one config reader that throws when unconfigured:

```ts
function read<Id>Config(env: Record<string, string | undefined>, mode: SdpEnvironment) {
  const key = (mode === "sandbox" ? env.<PROVIDER>_SANDBOX_KEY : env.<PROVIDER>_KEY)?.trim();
  if (!key) throw providerNotConfigured("<Provider> is not configured. Set <PROVIDER>_KEY.");
  return { key, /* … */ };
}
```

## Rules + verify

Shared rules live in `integrate-ramp-provider`. The ones you'll hit here:

- No fallbacks. Missing config throws `providerNotConfigured`; an unknown provider hits the `never` default and throws — don't soften either.
- HTTP in the provider; DB in the handler.
- Strong typing: the registry and availability maps are `as const satisfies Record<RampProviderId, …>`; no `any`.
- Verify with `tsc --noEmit` (the real checklist — it must be clean) + `biome check`. ESLint is broken repo-wide; don't use it.
