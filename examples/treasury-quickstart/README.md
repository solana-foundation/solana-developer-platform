# Treasury quickstart

The [Treasury quickstart](https://platform-beta.solana.com/docs/earn/treasury-quickstart),
ready to run: one sandbox deposit in two API requests and no signature, on
devnet with test tokens.

This is Treasury: the deposit comes from your organization's own funds, in a
custody wallet in your SDP project, and SDP signs through the wallet's custody
provider. It is not an Embedded Yield example, where a customer's own wallet
signs. For that, see
[`embedded-yield-quickstart`](../embedded-yield-quickstart).

| File          | What it is                           |
| ------------- | ------------------------------------ |
| `deposit.mts` | The page's TypeScript, top to bottom |
| `deposit.sh`  | The page's cURL path                 |

## Before you start

| You need               | How to get it                                                                                                                                        |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| A custody wallet       | [Create an account](https://platform-beta.solana.com/sign-up) on the hosted sandbox, then create a wallet in your sandbox project. Copy its address. |
| An API key             | Create a key with Earn **Execute** and Wallets **Read**, and give it access to that wallet.                                                          |
| Devnet USDC            | Send it to the wallet's address from the [Circle faucet](https://faucet.circle.com) on Solana Devnet.                                                |
| Node.js 20.18 or later | With pnpm. The cURL path also needs jq.                                                                                                              |

The deposit is 10 USDC. SDP pays the network fee while the strategy's
`feeSponsored` is `true`. Otherwise the wallet needs devnet SOL.

## Run it

```bash
pnpm install --frozen-lockfile
export SDP_API_KEY="sf_..."
export WALLET="..." # your custody wallet's address
pnpm deposit
```

For the cURL path, skip the install and run `./deposit.sh`.

Both print the deposit's final status, then your project's custody positions.

## Use another API

Requests go to the hosted sandbox, `https://api-beta.solana.com`. To use
another SDP API, such as one you run locally, set its URL:

```bash
export SDP_API_URL="http://127.0.0.1:8787"
```

## If the deposit is refused

A `403` with `details.reason` set to `provider_not_entitled` means SDP has not
activated the strategy's provider for your organization yet. Ask your SDP
contact, then run it again. `wallet_out_of_scope` means the key has no access
to the wallet. `deposit.mts` stops with `FORBIDDEN` and the API's message, and
`deposit.sh` prints the whole error.

Both stop earlier, with "This API key cannot see that wallet", when the key
cannot list a wallet with that address.

## Keeping it in step with the docs

These files mirror the code blocks of
[`treasury-quickstart.mdx`](../../apps/sdp-docs/content/docs/earn/treasury-quickstart.mdx).
`apps/sdp-docs/scripts/earn-quickstart-example.test.ts` fails when they differ,
so change the page and this folder together.
