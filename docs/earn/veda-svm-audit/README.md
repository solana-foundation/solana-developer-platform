# Veda SVM SDK audit, committed provenance

Verbatim reports from the 2026-08-17 audit of `@vedatech/svm-sdk@0.1.0-alpha.1`
against Veda's devnet + mainnet Test Vault (harness: `veda-svm-sdk-audit`,
run outside this repo). Committed because these reports plus Veda's
integration-docs deployment table are the chain of trust for the addresses in
`packages/sdp-types/src/veda-programs.ts`: the addresses are not publicly
indexed, so the on-chain verification here is what makes them auditable later.

- `SUMMARY.md`: all eight phases, pass/fail counts, failures and warnings.
- `01-on-chain-deployment-verification.md`: the phase that matters for
  `VEDA_DEPLOYMENTS`: per-cluster genesis proof, program existence and
  loaders, vault-state ownership, share-mint shape, and the asset-config
  check that the devnet vault references devnet USDC (and not mainnet's).

Mainnet was exercised read-only. Only devnet was ever signed.
