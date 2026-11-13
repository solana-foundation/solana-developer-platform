# Embedded Yield quickstart

The [Embedded Yield quickstart](https://platform-beta.solana.com/docs/earn/quickstart),
ready to run: one sandbox deposit in three API requests and one wallet
signature, on devnet with test tokens.

This is Embedded Yield: the deposit comes from your customer's own wallet,
which signs the transaction and holds the position. A local test keypair
stands in for that wallet. It is not a Treasury example, where your
organization's custody wallets deposit. For that, see
[`treasury-quickstart`](../treasury-quickstart).

| File                        | What it is                                    |
| --------------------------- | --------------------------------------------- |
| `deposit.ts`                | The page's TypeScript, top to bottom          |
| `deposit.sh` and `sign.mjs` | The page's cURL path, with the signing helper |

For a full app on the same API, see
[`embedded-yield-bank`](../embedded-yield-bank).

## Before you start

| You need               | How to get it                                                                                                                 |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| An API key             | [Create an account](https://platform-beta.solana.com/sign-up) on the hosted sandbox, then create a key with Earn **Execute**. |
| A test wallet          | `solana-keygen new --no-bip39-passphrase -o test-wallet.json`, in this folder. Git ignores it.                                |
| Devnet SOL and USDC    | The [Solana faucet](https://faucet.solana.com) and the [Circle faucet](https://faucet.circle.com) on Solana Devnet.           |
| Node.js 20.18 or later | With pnpm. The cURL path also needs jq.                                                                                       |

The deposit is 10 USDC.

## Run it

```bash
pnpm install --frozen-lockfile
export SDP_API_KEY="sf_..."
pnpm deposit
```

For the cURL path, run `./deposit.sh` in place of `pnpm deposit`.

Both print the deposit's final status, then the wallet's positions.

## Use another API

Requests go to the hosted sandbox, `https://api-beta.solana.com`. To use
another SDP API, such as one you run locally, set its URL:

```bash
export SDP_API_URL="http://127.0.0.1:8787"
```

## If the build is refused

A `403` with `details.reason` set to `provider_not_entitled` means SDP has not
activated the strategy's provider for your organization yet. `deposit.ts` stops
with `FORBIDDEN` and the API's message, and `deposit.sh` prints the whole error.
Ask your SDP contact, then run it again.

## Keeping it in step with the docs

These files mirror the code blocks of
[`quickstart.mdx`](../../apps/sdp-docs/content/docs/earn/quickstart.mdx).
`apps/sdp-docs/scripts/earn-quickstart-example.test.ts` fails when they differ,
so change the page and this folder together.
