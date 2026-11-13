# Mainnet plans for `sdp-intents prepare`

These plans name funded mainnet accounts, so that `prepare` can simulate them against a mainnet
RPC. A simulation checks no signatures and lands nothing, so the accounts do not belong to SDP.
Their balances change over time. Replace an account when its balance no longer covers a plan.

The registry is not on mainnet, so each intent turns off `verifyIntent`.

```
cargo run -q -p sdp-intents-cli -- prepare fixtures/plans/mainnet/usdc-and-sol-transfers.json --rpc https://api.mainnet-beta.solana.com
```
