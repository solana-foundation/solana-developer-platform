# BYOK provider policy observations (PRO-2364 / SDP-015)

SDP checks policy presence after connecting Fireblocks or Privy and after adding
a connection wallet. The worker's `check-custody-provider-policies` job runs once
a minute per project environment, claims up to 25 due wallets, and checks each
wallet hourly. Overlapping workers claim different wallets. An interrupted claim
becomes eligible again after five minutes; a failed audited write rolls back the
observation and the worker retries it. A new or rotated credential is checked on
the next eligible pass. This is advisory: neither setup nor signing is blocked.

## What the result proves

- **present:** Fireblocks returned a native Solana or canonical USDC `TRANSFER`
  rule whose source includes the connected vault, or Privy returned at least one
  `policy_ids` entry on that exact wallet. This does not assess rule ordering,
  initiators, destinations, limits, approvers or policy strength. Fireblocks RAW
  signing and program-call policies are outside this check.
- **missing:** a successful provider read contains no matching policy. An empty
  Privy app or policies attached to other wallets do not prove wallet coverage.
- **unknown:** access was denied, the provider or credential store was unavailable,
  the response could not be interpreted, no check has completed, the credential
  changed, or the observation is at least two hours old.

The documented Fireblocks Editor user cannot read policies. Expect `unknown` with
`access_denied` for that setup. Do not elevate the signing credential merely to
silence the warning; have an authorized operator inspect the published policy.

Only status, reason, timestamp and the credential identity are stored on each
wallet. The connection read aggregates its active wallets: any missing policy
wins, then unknown, then present. The audit ledger records each observation under
`custody_connection`, action `check`, event `custody_provider_policy_checked`, with
the wallet and project IDs. An obsolete claim or credential cannot publish a new
observation. Provider policies, response bodies and secrets are never persisted
or logged. The wallet detail API returns only that wallet's observation, after
the usual project and wallet-grant authorization.

Provider reads per batch: previously zero; now one Privy wallet GET per due wallet,
or one Fireblocks active-policy GET per credential shared by its due vaults. If a
vault has only asset-specific transfer rules outside native SOL, the existing
five-minute successful asset-catalogue cache resolves canonical USDC (at most one
additional GET per credential per cache interval). Solana RPC calls remain zero.

## Grafana response

The companion `sdp-infra` rule `sdp-custody-provider-policy-missing` uses the latest
`sdp_api_custody_provider_policy_checked` observation for each wallet within two
hours. It filters **project environment** `production`, separately from deployment
`env=prod`. `policyMissing=1` alerts; the next recorded present or unknown result
is `0`. Unknown means the absence can no longer be confirmed, not that a policy
was fixed. The dashboard continues warning on unknown. A disappeared wallet or
stopped check ages out after two hours; use the worker error/staleness alerts to
investigate an absent checker. Merge the application change before the infra rule.

1. Read `projectId`, `custodyConnectionId`, `custodyWalletId`, `provider`, and
   `reason` in the event. Open that project's connection and wallet detail pages.
2. Ask an authorized operator to inspect the provider's published configuration.
   For Fireblocks, check Transfer rules for every imported vault, SOL/USDC,
   initiators, destinations and required approvals. For Privy, inspect the
   policies attached to the specific wallet, including any signer overrides.
3. Configure the intended restrictions in the provider. SDP does not edit them.
   The next hourly observation should report present. Confirm the actual rules
   separately; a permissive rule also counts as present.
4. For unknown, check API permissions and provider availability. A 403, timeout,
   rate limit or malformed response must never be treated as proof of absence.
5. Confirm the new ledger observation and Grafana state. If checks stop, inspect
   `check-custody-provider-policies` cron runs and audit-ledger health. The worker
   reports a failed run when persistence fails.

The ticket's customer-feedback follow-up remains a product task: ask the first
customers about custody-policy requirements. No customer outreach is automated.

Provider references: [Fireblocks active policy](https://developers.fireblocks.com/reference/getactivepolicylegacy),
[source selectors](https://developers.fireblocks.com/reference/configure-transaction-authorization-policy),
and [Privy wallet policy IDs](https://docs.privy.io/api-reference/wallets/get).
