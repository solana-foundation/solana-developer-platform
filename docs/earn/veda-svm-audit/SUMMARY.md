# Veda SVM SDK — audit summary

Generated 2026-08-17T20:45:44.337Z

Target: `@vedatech/svm-sdk@0.1.0-alpha.1` against Veda's devnet + mainnet Test Vault.

Mainnet was exercised read-only (reads, previews, simulation). Only devnet was
ever signed, per Veda checklist item 8.

| Phase | Pass | Fail | Warn | Skip | Run at |
| --- | --- | --- | --- | --- | --- |
| 01 on-chain deployment verification | 62 | 0 | 9 | 0 | 19:53:12 |
| 02 package + supply-chain audit | 9 | 0 | 1 | 0 | 20:00:42 |
| 03 API surface conformance | 46 | 0 | 0 | 0 | 20:00:49 |
| 04 SDK reads + deployment validation | 37 | 0 | 2 | 2 | 20:43:56 |
| 05 preview + quote correctness | 12 | 0 | 0 | 0 | 20:44:31 |
| 06 build + prepare + simulate | 38 | 1 | 0 | 0 | 20:34:53 |
| 07 negative + error recovery | 14 | 2 | 1 | 0 | 20:20:43 |
| 08 full devnet lifecycle | 28 | 2 | 1 | 0 | 20:15:37 |
| **total** | **246** | **5** | **14** | **2** | |

## Failures

- **devnet — prepareCancelWithdrawal() on a live request**
  - expected: `call succeeds`
  - actual: `QueueParametersError: INVALID_QUEUE_PARAMETERS Withdrawal request cannot be cancelled before its deadline`
- **devnet — deposit with BOTH minAmountOut and slippageBps is rejected**
  - expected: `throws SLIPPAGE_PROTECTION_REQUIRED`
  - actual: `resolved with object`
  - invalid input was accepted -- validation gap
- **devnet — number (not bigint) amount is rejected rather than coerced**
  - expected: `VedaSdkError`
  - actual: `untyped TypeError: Cannot mix BigInt and other types, use explicit conversions`
  - guide promises typed VedaSdkError subclasses with stable codes
- **devnet — cancelWithdrawal() before expiry**
  - expected: `call succeeds`
  - actual: `QueueParametersError: INVALID_QUEUE_PARAMETERS Withdrawal request cannot be cancelled before its deadline`
- **devnet — cancelWithdrawal() after expiry**
  - expected: `call succeeds`
  - actual: `QueueParametersError: INVALID_QUEUE_PARAMETERS Withdrawal request cannot be cancelled before its deadline`

## Warnings

- **devnet — vault program is UPGRADEABLE**
  - actual: `GadV9XZnJa71XRGtgvqnzkgnKsUZthnVma8ChvMZhGke`
  - authority can replace program bytecode; last deployed slot 483612002
- **devnet — queue program is UPGRADEABLE**
  - actual: `GadV9XZnJa71XRGtgvqnzkgnKsUZthnVma8ChvMZhGke`
  - authority can replace program bytecode; last deployed slot 483612364
- **devnet — hook program is UPGRADEABLE**
  - actual: `GadV9XZnJa71XRGtgvqnzkgnKsUZthnVma8ChvMZhGke`
  - authority can replace program bytecode; last deployed slot 483612157
- **devnet — queue signing/escrow PDA not initialised**
  - actual: `account not found`
  - valid if used only as a signing PDA, but the guide lists it as an account
- **mainnet — vault program is UPGRADEABLE**
  - actual: `GadV9XZnJa71XRGtgvqnzkgnKsUZthnVma8ChvMZhGke`
  - authority can replace program bytecode; last deployed slot 439166122
- **mainnet — queue program is UPGRADEABLE**
  - actual: `GadV9XZnJa71XRGtgvqnzkgnKsUZthnVma8ChvMZhGke`
  - authority can replace program bytecode; last deployed slot 439166455
- **mainnet — hook program is UPGRADEABLE**
  - actual: `GadV9XZnJa71XRGtgvqnzkgnKsUZthnVma8ChvMZhGke`
  - authority can replace program bytecode; last deployed slot 439166265
- **mainnet — queue signing/escrow PDA not initialised**
  - actual: `account not found`
  - valid if used only as a signing PDA, but the guide lists it as an account
- **cross — programs + vault id are IDENTICAL across clusters**
  - actual: `3wbKP5UGLT7gAZBAsLjvPC1NbfnWKtT3Dq7cniMWkzfU`
  - a client pointed at the wrong RPC still resolves every account; only the base mint differs. Gate cluster selection on genesis hash, not addresses.
- **deps — @solana/kit is a direct dependency, not a peer**
  - actual: `7.0.0`
  - risks a second kit instance alongside the app copy; signer/address brands may not interop
- **confusion — SDK cannot detect a wrong-cluster RPC**
  - devnet-labelled config validated cleanly against mainnet. Integrators must pin cluster identity themselves (e.g. assert getGenesisHash) -- validateDeployment() is not sufficient.
- **confusion — mismatched client reports MAINNET USDC as its asset**
  - a devnet-configured deposit path would quote against real mainnet USDC
- **devnet — zero-share instant withdrawal is rejected**
  - actual: `INVALID_AMOUNT`
  - typed error, but code was INVALID_AMOUNT; guide's recovery table implies ZERO_SHARES
- **devnet — shares remain escrowed in the queue**
  - actual: `500000`
  - run with --cancel-only after the request deadline to reclaim
