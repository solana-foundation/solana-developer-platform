# 01 on-chain deployment verification

Run: 2026-08-17T19:53:12.908Z

Result: 62 pass, 9 warn, 12 info

| Status | Scope | Check | Value | Note |
| --- | --- | --- | --- | --- |
| PASS | devnet | genesis hash proves cluster identity | `EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG` |  |
| PASS | devnet | vault program exists | `ASN8Cz36kQSZf2ZrgUbRShaKUpN4CJoTGdv6C5uMsy3J` |  |
| PASS | devnet | vault program is executable | `true` |  |
| PASS | devnet | vault program loader | `bpfLoaderUpgradeable` |  |
| WARN | devnet | vault program is UPGRADEABLE | `GadV9XZnJa71XRGtgvqnzkgnKsUZthnVma8ChvMZhGke` | authority can replace program bytecode; last deployed slot 483612002 |
| PASS | devnet | queue program exists | `fh8uapqMe4GWhep9rt9qZ56Pxi9SYszkuDKXckYMQTT` |  |
| PASS | devnet | queue program is executable | `true` |  |
| PASS | devnet | queue program loader | `bpfLoaderUpgradeable` |  |
| WARN | devnet | queue program is UPGRADEABLE | `GadV9XZnJa71XRGtgvqnzkgnKsUZthnVma8ChvMZhGke` | authority can replace program bytecode; last deployed slot 483612364 |
| PASS | devnet | hook program exists | `BmTjMtZGcvx5XB7LwRaGq3x9hdHG1SziYikjP9BAgoE2` |  |
| PASS | devnet | hook program is executable | `true` |  |
| PASS | devnet | hook program loader | `bpfLoaderUpgradeable` |  |
| WARN | devnet | hook program is UPGRADEABLE | `GadV9XZnJa71XRGtgvqnzkgnKsUZthnVma8ChvMZhGke` | authority can replace program bytecode; last deployed slot 483612157 |
| PASS | devnet | vault state exists | `3wbKP5UGLT7gAZBAsLjvPC1NbfnWKtT3Dq7cniMWkzfU` | 684 b64 chars, 4454400 lamports |
| PASS | devnet | vault state owned by vault program | `ASN8Cz36kQSZf2ZrgUbRShaKUpN4CJoTGdv6C5uMsy3J` |  |
| PASS | devnet | vault state is not executable | `false` |  |
| PASS | devnet | share mint exists | `CdV7pjj6WANsdasKsBvdKAn7qJL7cQ2Q3CJMBEe13WAV` |  |
| PASS | devnet | share mint is Token-2022 | `token2022` |  |
| INFO | devnet | share mint decimals | `6` |  |
| INFO | devnet | share supply (TVL proxy) | `7999990` | shares outstanding |
| INFO | devnet | share mint authority | `3wbKP5UGLT7gAZBAsLjvPC1NbfnWKtT3Dq7cniMWkzfU` |  |
| PASS | devnet | share mint has no freeze authority |  |  |
| INFO | devnet | share mint Token-2022 extensions | `metadataPointer, transferHook, tokenMetadata` |  |
| PASS | devnet | share mint has no transfer fee |  |  |
| PASS | devnet | queue state exists | `7XbSKzG8Kf1qsprNV1XE9YHNNpSV7jZBWLx1n4B6tSDf` | 236 b64 chars, 2122800 lamports |
| PASS | devnet | queue state owned by queue program | `fh8uapqMe4GWhep9rt9qZ56Pxi9SYszkuDKXckYMQTT` |  |
| PASS | devnet | queue state is not executable | `false` |  |
| WARN | devnet | queue signing/escrow PDA not initialised | `account not found` | valid if used only as a signing PDA, but the guide lists it as an account |
| PASS | devnet | queue share escrow ATA exists | `CoaoRNSGrezz2KYEUGLxcRPHhAkY7ra9CT9EHLCDPaBz` |  |
| PASS | devnet | escrow ATA is Token-2022 | `token2022` |  |
| PASS | devnet | escrow ATA mint is the share mint | `CdV7pjj6WANsdasKsBvdKAn7qJL7cQ2Q3CJMBEe13WAV` |  |
| PASS | devnet | escrow ATA owner is the queue PDA | `8QVcaE2Uk981p9r6VUzViXmEpkFJopsjmgtCENVkDmUM` |  |
| INFO | devnet | escrow ATA share balance | `1000000` |  |
| PASS | devnet | escrow ATA has immutableOwner (as documented) |  |  |
| PASS | devnet | queue vault permission exists | `5EvvuQymABMMxxSbEimEKcBsqcZ9rGXjCdfXGbre2xQk` | owner ASN8Cz36kQSZf2ZrgUbRShaKUpN4CJoTGdv6C5uMsy3J |
| PASS | devnet | USDC mint exists | `4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU` |  |
| PASS | devnet | USDC mint has 6 decimals | `6` |  |
| INFO | devnet | USDC mint program | `splToken` |  |
| PASS | devnet | vault state references this cluster's USDC mint |  | found at byte offset 190 |
| PASS | devnet | vault state does NOT reference mainnet USDC |  |  |
| PASS | mainnet | genesis hash proves cluster identity | `5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d` |  |
| PASS | mainnet | vault program exists | `ASN8Cz36kQSZf2ZrgUbRShaKUpN4CJoTGdv6C5uMsy3J` |  |
| PASS | mainnet | vault program is executable | `true` |  |
| PASS | mainnet | vault program loader | `bpfLoaderUpgradeable` |  |
| WARN | mainnet | vault program is UPGRADEABLE | `GadV9XZnJa71XRGtgvqnzkgnKsUZthnVma8ChvMZhGke` | authority can replace program bytecode; last deployed slot 439166122 |
| PASS | mainnet | queue program exists | `fh8uapqMe4GWhep9rt9qZ56Pxi9SYszkuDKXckYMQTT` |  |
| PASS | mainnet | queue program is executable | `true` |  |
| PASS | mainnet | queue program loader | `bpfLoaderUpgradeable` |  |
| WARN | mainnet | queue program is UPGRADEABLE | `GadV9XZnJa71XRGtgvqnzkgnKsUZthnVma8ChvMZhGke` | authority can replace program bytecode; last deployed slot 439166455 |
| PASS | mainnet | hook program exists | `BmTjMtZGcvx5XB7LwRaGq3x9hdHG1SziYikjP9BAgoE2` |  |
| PASS | mainnet | hook program is executable | `true` |  |
| PASS | mainnet | hook program loader | `bpfLoaderUpgradeable` |  |
| WARN | mainnet | hook program is UPGRADEABLE | `GadV9XZnJa71XRGtgvqnzkgnKsUZthnVma8ChvMZhGke` | authority can replace program bytecode; last deployed slot 439166265 |
| PASS | mainnet | vault state exists | `3wbKP5UGLT7gAZBAsLjvPC1NbfnWKtT3Dq7cniMWkzfU` | 684 b64 chars, 4454400 lamports |
| PASS | mainnet | vault state owned by vault program | `ASN8Cz36kQSZf2ZrgUbRShaKUpN4CJoTGdv6C5uMsy3J` |  |
| PASS | mainnet | vault state is not executable | `false` |  |
| PASS | mainnet | share mint exists | `CdV7pjj6WANsdasKsBvdKAn7qJL7cQ2Q3CJMBEe13WAV` |  |
| PASS | mainnet | share mint is Token-2022 | `token2022` |  |
| INFO | mainnet | share mint decimals | `6` |  |
| INFO | mainnet | share supply (TVL proxy) | `3999995` | shares outstanding |
| INFO | mainnet | share mint authority | `3wbKP5UGLT7gAZBAsLjvPC1NbfnWKtT3Dq7cniMWkzfU` |  |
| PASS | mainnet | share mint has no freeze authority |  |  |
| INFO | mainnet | share mint Token-2022 extensions | `metadataPointer, transferHook, tokenMetadata` |  |
| PASS | mainnet | share mint has no transfer fee |  |  |
| PASS | mainnet | queue state exists | `7XbSKzG8Kf1qsprNV1XE9YHNNpSV7jZBWLx1n4B6tSDf` | 236 b64 chars, 2122800 lamports |
| PASS | mainnet | queue state owned by queue program | `fh8uapqMe4GWhep9rt9qZ56Pxi9SYszkuDKXckYMQTT` |  |
| PASS | mainnet | queue state is not executable | `false` |  |
| WARN | mainnet | queue signing/escrow PDA not initialised | `account not found` | valid if used only as a signing PDA, but the guide lists it as an account |
| PASS | mainnet | queue share escrow ATA exists | `CoaoRNSGrezz2KYEUGLxcRPHhAkY7ra9CT9EHLCDPaBz` |  |
| PASS | mainnet | escrow ATA is Token-2022 | `token2022` |  |
| PASS | mainnet | escrow ATA mint is the share mint | `CdV7pjj6WANsdasKsBvdKAn7qJL7cQ2Q3CJMBEe13WAV` |  |
| PASS | mainnet | escrow ATA owner is the queue PDA | `8QVcaE2Uk981p9r6VUzViXmEpkFJopsjmgtCENVkDmUM` |  |
| INFO | mainnet | escrow ATA share balance | `0` |  |
| PASS | mainnet | escrow ATA has immutableOwner (as documented) |  |  |
| PASS | mainnet | queue vault permission exists | `5EvvuQymABMMxxSbEimEKcBsqcZ9rGXjCdfXGbre2xQk` | owner ASN8Cz36kQSZf2ZrgUbRShaKUpN4CJoTGdv6C5uMsy3J |
| PASS | mainnet | USDC mint exists | `EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v` |  |
| PASS | mainnet | USDC mint has 6 decimals | `6` |  |
| INFO | mainnet | USDC mint program | `splToken` |  |
| PASS | mainnet | vault state references this cluster's USDC mint |  | found at byte offset 190 |
| PASS | mainnet | vault state does NOT reference devnet USDC |  |  |
| PASS | cross | devnet and mainnet vault state are distinct accounts |  | same address string, different on-chain state, as documented |
| PASS | cross | USDC mints differ between clusters | `true` |  |
| WARN | cross | programs + vault id are IDENTICAL across clusters | `3wbKP5UGLT7gAZBAsLjvPC1NbfnWKtT3Dq7cniMWkzfU` | a client pointed at the wrong RPC still resolves every account; only the base mint differs. Gate cluster selection on genesis hash, not addresses. |
