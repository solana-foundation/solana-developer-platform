The four public CA certificates in `emudhra-roots.pem` come from
https://emudhra.we-have-a-problem.com/roots.json, retrieved on 2026-10-20.
Each certificate's SPKI SHA-256 was checked against that manifest. These are
test fixtures, never a trusted CA bundle. No private keys are included.

The tests deliberately supply these certificates through `NODE_EXTRA_CA_CERTS`
to prove that adding an affected root cannot restore default trust. The separate
`scripts/check-tls-trust.mjs` smoke check exercises all twelve published chains.
