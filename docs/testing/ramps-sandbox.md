# Ramps sandbox testing (local)

How to run a ramp end to end from a local stack against the providers'
sandboxes, with a real devnet transfer so the delivery verifier can complete
it. `ramp-provider-safety.md` in `docs/contributing/` lists what a ramp
change must prove; this page is how to produce that evidence locally.

Verified on 2026-10-19: a MoonPay off-ramp through MoonPay's sandbox widget,
from quote to `completed`, and a Stripe on-ramp through Stripe's sandbox
widget to `settling` (Stripe's test mode can't reach `completed`; see
Stripe below).

## Setup

1. Start the local stack (`docs/contributing/local-development.md`).
2. Ramps are an `experimental` module. For the run, set
   `SDP_RELEASE_CHANNEL=experimental` in `apps/sdp-api/.env.local` and
   `apps/sdp-web/.env.local`, and put it back afterwards.
3. Provider keys:
   - MoonPay: `pnpm dev:api` loads `MOONPAY_SANDBOX_API_KEY`,
     `MOONPAY_SANDBOX_SECRET_KEY` and `MOONPAY_SANDBOX_WEBHOOK_KEY` from
     Doppler `dev`.
   - Stripe: Doppler `dev` has no `STRIPE_SANDBOX_*` keys yet. Before
     `pnpm dev:api`, export `STRIPE_SANDBOX_SECRET_KEY` and
     `STRIPE_SANDBOX_PUBLISHABLE_KEY` from its test-mode `STRIPE_SECRET_KEY`
     and `STRIPE_PUBLISHABLE_KEY`, and `STRIPE_SANDBOX_WEBHOOK_SECRET` from
     `stripe listen --print-secret` (Stripe CLI, logged in with that key).
     During the run keep
     `stripe listen --events crypto.onramp_session.updated --forward-to http://localhost:8787/webhooks/payments/ramps/sandbox/stripe`
     open. CLI 1.53 warns the event type is unknown but forwards it.
4. Restart `pnpm dev:api` after every branch switch. `tsx watch` can miss a
   `git checkout` and keep serving the previous branch's code.
5. Fund the sandbox project's wallet. It lives on devnet.
   - USDC: faucet.circle.com, network Solana Devnet. MoonPay won't quote a
     sale under about 20 USDC.
   - SOL: `requestAirdrop` against the Triton devnet endpoint in Doppler
     `dev` (`SOLANA_RPC_TRITON_DEVNET_API_KEY_URL`). The public faucet and
     Helius devnet often refuse airdrops.

## Provider sandboxes

### MoonPay

Values from MoonPay's
[test mode](https://dev.moonpay.com/platform/overview/test-mode) and
[sandbox testing](https://dev.moonpay.com/widget/sandbox-testing) pages:

- Sign in with any `test-<label>@moonpay.test`; the code is `123456`.
  Phone, if asked: `+15005550000`, code `123456`.
- KYC is mocked: made-up details, a US or UK address, first name
  `Test-Approve` forces a pass, SSN any nine digits.
- Sale payout card: `4000 0209 5159 5032`, `12/30`, CVC `123`.
  Buy card (US): `4000 0200 0000 0000`, `12/30`, CVV `100`.
- The card form drops keystrokes typed quickly (browser automation
  especially). Type slowly and read the field back before submitting.

MoonPay's sandbox sends webhooks only to the URLs in MoonPay's dashboard,
never to a local API. After each state change in the widget, forward it
with the script below.

A sandbox sale does watch devnet: sending devnet USDC
(`4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU`) to the sale's deposit
address moved it to `pending` and then `completed` within about two
minutes. Buys are unverified: MoonPay lists Solana devnet as native SOL
only, so a USDC buy may never deliver.

### Stripe

- Link signs in with the device's passkey. Pay with card
  `4242 4242 4242 4242`, any future date, any CVC; a verification code, if
  asked, is `000000`.
- With `stripe listen` running, Stripe's own `crypto.onramp_session.updated`
  events reach the local API while the widget pays. A session rejected
  before payment sent none. To replay a session the listener missed, use
  the script below; the session id is the transfer's `provider_reference`
  (`cos_…`).
- Test mode overrides amounts: a 20 USDC purchase delivered 0.5 devnet
  USDC, while the session and its events still reported 20. The verifier
  refuses a delivery that differs from the reported amount, so a Stripe
  sandbox on-ramp stays `settling` (the worker logs "provider settlement
  still lacks matching chain proof" each minute). That is the verifier
  working, not a bug to chase.
- The card was charged $21.02 although the widget showed a $20.81 total.

## Forward a provider's record

`scripts/forward-ramp-sandbox-webhook.mjs` fetches the provider's own
record, wraps it as the webhook the provider sends, signs it with the
sandbox webhook key, and posts it to
`/webhooks/payments/ramps/sandbox/<provider>` on `SDP_API_URL` (default
`http://127.0.0.1:8787`). It never invents provider data and never prints a
key. It exits non-zero when its environment or a provider record doesn't
parse, or when the API refuses a webhook.

```bash
# MoonPay: every buy or sale MoonPay holds for the transfer, oldest first.
MOONPAY_SANDBOX_API_KEY="$(doppler secrets get MOONPAY_SANDBOX_API_KEY --plain --project solana-developer-platform --config dev)" \
MOONPAY_SANDBOX_WEBHOOK_KEY="$(doppler secrets get MOONPAY_SANDBOX_WEBHOOK_KEY --plain --project solana-developer-platform --config dev)" \
  node scripts/forward-ramp-sandbox-webhook.mjs moonpay xfr_...

# Stripe: the session's current state. The webhook secret must be the one
# the running API verifies with.
STRIPE_SANDBOX_SECRET_KEY="$(doppler secrets get STRIPE_SECRET_KEY --plain --project solana-developer-platform --config dev)" \
STRIPE_SANDBOX_WEBHOOK_SECRET="$(stripe listen --print-secret)" \
  node scripts/forward-ramp-sandbox-webhook.mjs stripe cos_...
```

Forwarding again is safe: a state SDP already applied is recorded as
`ignored`.

## Off-ramp walkthrough (MoonPay)

1. Payments > Pay > contact > "Pay to a bank account instead" > wallet >
   amount > MoonPay > memo > Continue. The row is `pending`.
2. In the widget: sign in, finish KYC, add the payout card, then "Continue
   to sell USDC". MoonPay shows its deposit address.
3. Forward. The row is `awaiting_payment`, with MoonPay's address and amount
   in `provider_data.cryptoDeposit`; the wizard offers "Send N USDC".
4. Send. The row is `settling` with SDP's signature; the widget moves to
   selling.
5. When the widget says the sale is complete, forward again.
   `provider_data.providerSettlement` holds MoonPay's payout; the row stays
   `settling`.
6. Within a minute the worker's `verify-ramp-deliveries` run checks the
   deposit is finalized and writes `completed` with
   `provider_data.verifiedDelivery`.

## On-ramp walkthrough

1. Payments > Deposit > "Card or bank through a provider" > contact,
   amount, wallet, asset > provider > Continue to the widget.
2. Pay in the widget. Stripe's events arrive through `stripe listen`; for
   MoonPay, forward (`moonpay xfr_...`) after each state change. The row is
   `settling` with the provider's delivery signature.
3. The verifier completes the row only from a finalized transaction that
   delivered the reported amount of the quoted asset to the wallet after the
   transfer was created. Otherwise the row stays `settling`, which is what
   Stripe's test mode produces (see Stripe above).

## Check the database

```sql
select id, type, status, provider_reference, amount, signature,
       provider_data->'cryptoDeposit' as deposit,
       provider_data->'providerSettlement' as settlement,
       provider_data->'verifiedDelivery' as verified, updated_at
  from payment_transfers where id = 'xfr_...';

select provider, status, apply_outcome, last_error, created_at
  from ramp_webhook_events order by created_at desc limit 5;
```

These should all return no rows or zero:

```sql
-- completed ramp without chain proof
select count(*) from payment_transfers
 where type in ('onramp','offramp') and status = 'completed'
   and provider_data->'verifiedDelivery' is null;
-- funded off-ramp without SDP's signature
select count(*) from payment_transfers
 where type = 'offramp' and status in ('settling','completed') and signature is null;
-- one signature proving two transfers
select signature, count(*) from payment_transfers
 where signature is not null group by 1 having count(*) > 1;
```

`created_at` and `updated_at` are text columns, so compare them as ISO
strings rather than timestamps.
