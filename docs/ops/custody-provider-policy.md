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
  rule whose source includes the connected vault and whose action requires
  approval (a `2-TIER` action or configured approvers) or blocks the transfer,
  or Privy returned at least one `policy_ids` entry on that exact wallet. This
  does not assess rule ordering, initiators, destinations, limits or policy
  strength. Fireblocks RAW signing and program-call policies are outside this check.
- **missing:** a successful provider read contains no matching policy, or the only
  matching Fireblocks rule is an `ALLOW` with no approvers — the credential could
  move funds alone. An empty Privy app or policies attached to other wallets do
  not prove wallet coverage.
- **unknown:** access was denied, the provider or credential store was unavailable,
  the response could not be interpreted, no check has completed, the credential
  changed, or the observation is at least two hours old.

The documented Fireblocks Editor user cannot read policies, so the check calls the
active-policy endpoint in vain: expect `unknown` with `access_denied` for that setup.
A workspace that wants the hourly check to verify on its own can register the
connection with an API user whose role may read the workspace's active policy,
accepting the wider permission on SDP's credential; the check only reads policies,
never edits or publishes them. Do not elevate the signing credential merely to
silence the warning; have an authorized operator inspect the published policy
instead.

Only status, reason, timestamp and the credential identity are stored on each
wallet. The connection read aggregates its active wallets: any missing policy
wins, then unknown, then present. The audit ledger records each changed observation
under `custody_connection`, action `check`, event `custody_provider_policy_checked`,
with the wallet and project IDs; an unchanged hourly repeat refreshes the wallet's
observation without a new ledger row, while the log line stays hourly. An obsolete
claim or credential cannot publish a new observation. Provider policies, response
bodies and secrets are never persisted or logged. The wallet detail API returns only
that wallet's observation, after the usual project and wallet-grant authorization.

Provider reads per batch: previously zero; now one Privy wallet GET per due wallet
(reads run five wallets at a time), or one Fireblocks active-policy GET per
credential shared by its due vaults. If a
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
   separately; a rule that allows transfers without approvers is reported as
   missing.
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
