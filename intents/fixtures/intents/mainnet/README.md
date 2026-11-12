# Mainnet intents for `sdp-intents prepare`

These intents name funded mainnet accounts, so that `prepare` can simulate them against a mainnet
RPC. A simulation checks no signatures and lands nothing, so the accounts do not belong to SDP.
Their balances change over time. Replace an account when its balance no longer covers the intent.

```
cargo run -q -p sdp-intents-cli -- prepare fixtures/intents/mainnet/usdc-transfer.json --rpc https://api.mainnet-beta.solana.com
```
