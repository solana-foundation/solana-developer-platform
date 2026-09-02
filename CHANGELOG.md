# Changelog

## [0.70.0](https://github.com/solana-foundation/solana-developer-platform/compare/v0.69.0...v0.70.0) (2026-09-02)

### Features

* **web:** streamline counterparty creation and section ramp requirement forms ([#1580](https://github.com/solana-foundation/solana-developer-platform/pull/1580)) ([c6d27ac](https://github.com/solana-foundation/solana-developer-platform/commit/c6d27ac39987be1599a3cbf9e953544dc7cf849a))
* **earn:** surface Veda and confirm its devnet Test Vault deployment ([#1564](https://github.com/solana-foundation/solana-developer-platform/pull/1564)) ([1d26c81](https://github.com/solana-foundation/solana-developer-platform/commit/1d26c8129c09a3a26c08f18f66d8e5e4b59d437b))
* **earn:** curated V1 Kamino shelf, TVL ranking, liquidity/provider columns ([#1562](https://github.com/solana-foundation/solana-developer-platform/pull/1562)) ([07e7063](https://github.com/solana-foundation/solana-developer-platform/commit/07e706358289874fd21b9d6ac09810051c4d080e))
* **payments:** Lightspark per-corridor payouts and Grid settlement webhooks ([#1577](https://github.com/solana-foundation/solana-developer-platform/pull/1577)) ([8e0597d](https://github.com/solana-foundation/solana-developer-platform/commit/8e0597d191ee170a0a05c1da7156dbe29f4def12))
* **api:** per-call vendor telemetry at every client boundary ([#1530](https://github.com/solana-foundation/solana-developer-platform/pull/1530)) ([d4e6f30](https://github.com/solana-foundation/solana-developer-platform/commit/d4e6f304e43a169e3115ebaddc096aeabd367d78))
* **payments:** add a compile-checked surfacing gate for ramp providers ([#1493](https://github.com/solana-foundation/solana-developer-platform/pull/1493)) ([1f6051e](https://github.com/solana-foundation/solana-developer-platform/commit/1f6051eb6e0ec913d4987f5e3e47393b02c04fb6))
* **web:** polish Embedded Yield portfolio ([#1563](https://github.com/solana-foundation/solana-developer-platform/pull/1563)) ([829d1dd](https://github.com/solana-foundation/solana-developer-platform/commit/829d1dddd8e7dcfeccb17545df7f28ea57711722))
* **earn:** swap-funded deposits — pay in USDC/USDG/PYUSD/USDT, Jupit… ([#1559](https://github.com/solana-foundation/solana-developer-platform/pull/1559)) ([2058445](https://github.com/solana-foundation/solana-developer-platform/commit/20584452156abb36261163784e935daafa3f9b5a))
* **payments:** collect Lightspark purpose-of-payment in counterparty requirements ([#1572](https://github.com/solana-foundation/solana-developer-platform/pull/1572)) ([96c90cd](https://github.com/solana-foundation/solana-developer-platform/commit/96c90cde56d0f118e713194125f7ff75281e8601))
* **payments:** create Lightspark customers from JIT identity collection ([#1570](https://github.com/solana-foundation/solana-developer-platform/pull/1570)) ([25cbe4f](https://github.com/solana-foundation/solana-developer-platform/commit/25cbe4f4de3a6c4bd5dbb13833976fc369a471c3))
* **private-channels:** replace invitations with project identities ([#1558](https://github.com/solana-foundation/solana-developer-platform/pull/1558)) ([989f43f](https://github.com/solana-foundation/solana-developer-platform/commit/989f43f873d6a7015100ef2e4705fe8dc12551bc))
* **ramps:** rework rail discovery into ramp-support generation script ([#1568](https://github.com/solana-foundation/solana-developer-platform/pull/1568)) ([8304d46](https://github.com/solana-foundation/solana-developer-platform/commit/8304d4644bf0b59225c033f72c62dfe7868be641))
* **ci:** continuous prod deploy via a single path-filtered deploy orchestrator ([#1544](https://github.com/solana-foundation/solana-developer-platform/pull/1544)) ([35be4cf](https://github.com/solana-foundation/solana-developer-platform/commit/35be4cf973b13c1324bfb6b389e91a095e9fb573))
* **web:** compact asset header + sidebar account menu ([#1567](https://github.com/solana-foundation/solana-developer-platform/pull/1567)) ([df638e7](https://github.com/solana-foundation/solana-developer-platform/commit/df638e7b094b299e9559055083685f0b22ebe876))
* **earn:** remove the Embedded Yield UI builder for a direct integration guide ([#1557](https://github.com/solana-foundation/solana-developer-platform/pull/1557)) ([a1aa522](https://github.com/solana-foundation/solana-developer-platform/commit/a1aa522de37d102759f5a6d5903a2162df686961))
* **earn:** external-wallet activity + earnings reads, full-loop embedded-yield integration ([#1556](https://github.com/solana-foundation/solana-developer-platform/pull/1556)) ([1fbc813](https://github.com/solana-foundation/solana-developer-platform/commit/1fbc8131b79783b65c40be15cebd2d7d06769db9))
* **helius:** support simplified shield, withdraw and private transfers ([#1534](https://github.com/solana-foundation/solana-developer-platform/pull/1534)) ([2fb220d](https://github.com/solana-foundation/solana-developer-platform/commit/2fb220db432126d4d3ef8ef3dc15b11574ef44cb))
* **markets:** align Treasury workspace with Figma ([#1553](https://github.com/solana-foundation/solana-developer-platform/pull/1553)) ([762707c](https://github.com/solana-foundation/solana-developer-platform/commit/762707cf1c753ad57c9841e732eeddf2868d4a3e))
* **payments:** use exact SDP wallet IDs for execution ([#1509](https://github.com/solana-foundation/solana-developer-platform/pull/1509)) ([9099e50](https://github.com/solana-foundation/solana-developer-platform/commit/9099e506ef81184021884a3306cf03db12819613))
* **ci:** deploy the signed, attested release image instead of rebuilding it ([#1519](https://github.com/solana-foundation/solana-developer-platform/pull/1519)) ([0e40cf6](https://github.com/solana-foundation/solana-developer-platform/commit/0e40cf6488ad920222396e6f5b6f6f63bcb6fa8a))
* **api:** add exact runtime execution admission ([#1473](https://github.com/solana-foundation/solana-developer-platform/pull/1473)) ([6f6ba12](https://github.com/solana-foundation/solana-developer-platform/commit/6f6ba12e3e0a1cdcfda30b750a6a7bad333a688f))

### Bug Fixes

* **ci:** grant packages read to the prod deploy lane so the orchestrator can start ([#1578](https://github.com/solana-foundation/solana-developer-platform/pull/1578)) ([28aa763](https://github.com/solana-foundation/solana-developer-platform/commit/28aa763bbec1fb72fe0fce7d798013223d7d8d2e))
* **ci:** route vendor drift to the alerts webhook, not the deploy channel ([#1566](https://github.com/solana-foundation/solana-developer-platform/pull/1566)) ([23e22fd](https://github.com/solana-foundation/solana-developer-platform/commit/23e22fd89ba54e5dcd4fcee9cfc6af127cacbb74))
* **cron:** emit sdp_cron_run proof-of-life for feature-gated ticks ([#1561](https://github.com/solana-foundation/solana-developer-platform/pull/1561)) ([9cf0de7](https://github.com/solana-foundation/solana-developer-platform/commit/9cf0de7c8d66f8e80b125575b350292ebf16e92b))
* **api:** run tsx through node so dev:local starts on Windows ([#1525](https://github.com/solana-foundation/solana-developer-platform/pull/1525)) ([891ac0b](https://github.com/solana-foundation/solana-developer-platform/commit/891ac0b405ae74d3103c8784bb795463b4f3bba9))
* **private-channels:** verify project RPC deployment ([#1550](https://github.com/solana-foundation/solana-developer-platform/pull/1550)) ([ca2a84c](https://github.com/solana-foundation/solana-developer-platform/commit/ca2a84c874c0348f27e02dd743f482e638999ce4))
* **web:** finish private channels connection setup ([#1549](https://github.com/solana-foundation/solana-developer-platform/pull/1549)) ([16fa412](https://github.com/solana-foundation/solana-developer-platform/commit/16fa412d49bb26dccc809b9c39a25e5bbf7f2169))
* **payments:** complete MoonPay off-ramp settlement flow ([#1528](https://github.com/solana-foundation/solana-developer-platform/pull/1528)) ([9f28d2a](https://github.com/solana-foundation/solana-developer-platform/commit/9f28d2a2638c07586614a3d2efee7283af5d519c))

### Maintenance

* **earn:** stop pinning surfaced-shelf size in workspace tests ([#1581](https://github.com/solana-foundation/solana-developer-platform/pull/1581)) ([a7ced02](https://github.com/solana-foundation/solana-developer-platform/commit/a7ced02e613368da00cbc3e7b75decfac2796153))
* authenticate CI and deploy workflows to Doppler via OIDC ([#1571](https://github.com/solana-foundation/solana-developer-platform/pull/1571)) ([3cfe807](https://github.com/solana-foundation/solana-developer-platform/commit/3cfe807daedf758b449c47bc221f1821b3ee35d2))
* UI flow matrix with dashboard route audit ([#1551](https://github.com/solana-foundation/solana-developer-platform/pull/1551)) ([7d00728](https://github.com/solana-foundation/solana-developer-platform/commit/7d00728ee02a27725aa0c0f329b63d4758e538e9))
* **ramps:** remove dead redirectUrl / RAMP_REDIRECT_ALLOWED_HOSTS stack ([#1565](https://github.com/solana-foundation/solana-developer-platform/pull/1565)) ([ad1969b](https://github.com/solana-foundation/solana-developer-platform/commit/ad1969bf76805288b47b8f6fa9a65069d1a745a9))
* **veda:** reach the private @vedatech npm scope, and make Veda key… ([#1412](https://github.com/solana-foundation/solana-developer-platform/pull/1412)) ([1f7e7af](https://github.com/solana-foundation/solana-developer-platform/commit/1f7e7afa41834b669e54c40c174ba6338e6432e8))
* **deps:** upgrade @solana/kit 7.1.1 ([#1490](https://github.com/solana-foundation/solana-developer-platform/pull/1490)) ([e1c9f44](https://github.com/solana-foundation/solana-developer-platform/commit/e1c9f441daefd76c499e20a3b8b8fc0eea71fd75))

### Other Changes

* **helius:** remove the Rust Rings gateway sidecar ([#1576](https://github.com/solana-foundation/solana-developer-platform/pull/1576)) ([36a6dc6](https://github.com/solana-foundation/solana-developer-platform/commit/36a6dc626d9533376a2f5925e2a6ae8b1d4c6753))

## [0.69.0](https://github.com/solana-foundation/solana-developer-platform/compare/v0.68.0...v0.69.0) (2026-08-31)

### Features

* **earn:** add partner position reads ([#1524](https://github.com/solana-foundation/solana-developer-platform/pull/1524)) ([f84bdb3](https://github.com/solana-foundation/solana-developer-platform/commit/f84bdb310481165d7e6e377514ad9b6e8bc845c7))
* **earn:** rename dashboard to Embedded Yield ([#1514](https://github.com/solana-foundation/solana-developer-platform/pull/1514)) ([b5cdc02](https://github.com/solana-foundation/solana-developer-platform/commit/b5cdc02c46827498ad03145a908e021a9314a0f5))
* **observability:** live verification — cron proof-of-life, error events, dev API/UI smoke, coverage ratchets ([#1522](https://github.com/solana-foundation/solana-developer-platform/pull/1522)) ([d77687e](https://github.com/solana-foundation/solana-developer-platform/commit/d77687e377ef40c318b7ab39532397fb5d62c436))
* **payments:** MoonPay lifecycle, transferId polling, counterparty provider links ([#1513](https://github.com/solana-foundation/solana-developer-platform/pull/1513)) ([5abe562](https://github.com/solana-foundation/solana-developer-platform/commit/5abe56288819e43519c6b4c1e100d6e942f9b359))

### Bug Fixes

* **rpc:** constrain a project to one live connection per provider ([#1511](https://github.com/solana-foundation/solana-developer-platform/pull/1511)) ([4afc203](https://github.com/solana-foundation/solana-developer-platform/commit/4afc203a7793d9eb903882e16c2d0dad6c80db3b))
* **credentials:** accept the canonical project number in GCP secret refs ([#1526](https://github.com/solana-foundation/solana-developer-platform/pull/1526)) ([af714be](https://github.com/solana-foundation/solana-developer-platform/commit/af714be9c6548be07a8740c3b5bc1e24b0f066e2))
* **api:** HOO-1006 ramp session binding ([#1450](https://github.com/solana-foundation/solana-developer-platform/pull/1450)) ([d467f6c](https://github.com/solana-foundation/solana-developer-platform/commit/d467f6c12fb9e4c9a6656d211e8f4b558503577e))
* **web:** expand a side-menu section when its top-level item is followed ([#1508](https://github.com/solana-foundation/solana-developer-platform/pull/1508)) ([d9f16d6](https://github.com/solana-foundation/solana-developer-platform/commit/d9f16d604c9179715d36742dfe9115df8fb73caa))

### Performance Improvements

* **ci:** v8 coverage provider for sdp-api ([#1531](https://github.com/solana-foundation/solana-developer-platform/pull/1531)) ([e887959](https://github.com/solana-foundation/solana-developer-platform/commit/e887959aa8a074878c5c09feedca5ba960321a9e))

### Refactors

* **web:** consolidate SWR query keys into per-feature factories ([#1529](https://github.com/solana-foundation/solana-developer-platform/pull/1529)) ([e1ff62f](https://github.com/solana-foundation/solana-developer-platform/commit/e1ff62f0baf7c5ceb9c8d4ee5e9d5b518c790f3a))

### Maintenance

* **vendor:** scheduled drift check for pinned third-party assets ([#1502](https://github.com/solana-foundation/solana-developer-platform/pull/1502)) ([f0f7053](https://github.com/solana-foundation/solana-developer-platform/commit/f0f7053fc2265432c3bba8c8a6a53b7bf9e2c714))
* **slack:** prod-only deploy notifications with commit context ([#1521](https://github.com/solana-foundation/solana-developer-platform/pull/1521)) ([ada65de](https://github.com/solana-foundation/solana-developer-platform/commit/ada65de03e62032bc1bf49893e7ca9e86e38c580))
* **smoke:** remove Actions prod leg, superseded by Cloud Run canary ([#1516](https://github.com/solana-foundation/solana-developer-platform/pull/1516)) ([3e9f94b](https://github.com/solana-foundation/solana-developer-platform/commit/3e9f94bb97a35b103b9066ed6d8f7f4e5569a55b))

## [0.68.0](https://github.com/solana-foundation/solana-developer-platform/compare/v0.67.1...v0.68.0) (2026-08-28)

### Features

* **earn:** translate vault simulation errors into readable verdicts ([#1512](https://github.com/solana-foundation/solana-developer-platform/pull/1512)) ([51509cb](https://github.com/solana-foundation/solana-developer-platform/commit/51509cb09d6a2a5fcd83d094e56a958f4f1d304d))
* **earn:** deposit and exit for external wallets SDP does not custody (PRO-1722) ([#1495](https://github.com/solana-foundation/solana-developer-platform/pull/1495)) ([162d669](https://github.com/solana-foundation/solana-developer-platform/commit/162d66911a0ff03ee45ce6688e820e0dd6ecb7f5))
* **rpc:** scope BYOK connections to a project and check them on save ([#1482](https://github.com/solana-foundation/solana-developer-platform/pull/1482)) ([9602c47](https://github.com/solana-foundation/solana-developer-platform/commit/9602c47fefb92ee440c873fba5686d5544bba0f1))
* **helius:** implement Rings identity provisioning, shielded reads, and shield deposits ([#1500](https://github.com/solana-foundation/solana-developer-platform/pull/1500)) ([9fffdad](https://github.com/solana-foundation/solana-developer-platform/commit/9fffdad60c0d26c5d57eb6bd93a1b576b52d74df))
* **payments:** log and capture swallowed ramp provider estimate errors ([#1492](https://github.com/solana-foundation/solana-developer-platform/pull/1492)) ([1777e4a](https://github.com/solana-foundation/solana-developer-platform/commit/1777e4a1e2d70e5f005211f65d5080eb4ac697c9))
* **earn:** catalogue mainnet strategies in sandbox behind a cluster toggle (PRO-1742) ([#1485](https://github.com/solana-foundation/solana-developer-platform/pull/1485)) ([a83bb8c](https://github.com/solana-foundation/solana-developer-platform/commit/a83bb8cc09376240801cdd52e2894e94f9ff0a3d))
* **earn:** add persistent button integration builder ([#1470](https://github.com/solana-foundation/solana-developer-platform/pull/1470)) ([60270db](https://github.com/solana-foundation/solana-developer-platform/commit/60270db5aeee6954c0d537bcd5ac1aadd4830c0a))
* **private-channels:** use project RPC configuration ([#1487](https://github.com/solana-foundation/solana-developer-platform/pull/1487)) ([836c748](https://github.com/solana-foundation/solana-developer-platform/commit/836c74871c196ec3a9b69f619b406357ff785c0d))
* **docs:** update docs to reflect new changes ([#860](https://github.com/solana-foundation/solana-developer-platform/pull/860)) ([9628cfc](https://github.com/solana-foundation/solana-developer-platform/commit/9628cfc045a81e923e9bef944f9ff069a09a0825))
* **earn:** drop the mechanism-split movement tables (PRO-1705) ([#1411](https://github.com/solana-foundation/solana-developer-platform/pull/1411)) ([0ea6d86](https://github.com/solana-foundation/solana-developer-platform/commit/0ea6d86cd57408f45a83d30047fcfe657f0d3796))
* **web:** PRO-1723 show available cash, deployed and remaining on the Treasury overview ([#1468](https://github.com/solana-foundation/solana-developer-platform/pull/1468)) ([10056c1](https://github.com/solana-foundation/solana-developer-platform/commit/10056c1dd710ceb31f7ae65787766b0286187d8f))

### Bug Fixes

* **security:** resolve GitHub dependency and CodeQL alerts ([#1515](https://github.com/solana-foundation/solana-developer-platform/pull/1515)) ([655c310](https://github.com/solana-foundation/solana-developer-platform/commit/655c310bd964e6142efe58d8ae203ee469242d71))
* **deploy:** roll the reconciliation worker image with prod releases ([#1488](https://github.com/solana-foundation/solana-developer-platform/pull/1488)) ([2256b2e](https://github.com/solana-foundation/solana-developer-platform/commit/2256b2eb87f73c3af0fc4eb2f0f8f5746f0484d2))
* **deploy:** roll the reconciliation worker image with dev releases ([#1479](https://github.com/solana-foundation/solana-developer-platform/pull/1479)) ([6224dd4](https://github.com/solana-foundation/solana-developer-platform/commit/6224dd405029e0741f4715e8ae2ba43b4152935f))
* **i18n:** retranslate stale catalog entries instead of wedging the release flow ([#1437](https://github.com/solana-foundation/solana-developer-platform/pull/1437)) ([68a17d8](https://github.com/solana-foundation/solana-developer-platform/commit/68a17d865836257ed0fdfc22cef6c147de5f9a7a))
* **cron:** give managed monitors a check-in margin covering job startup ([#1483](https://github.com/solana-foundation/solana-developer-platform/pull/1483)) ([73d8611](https://github.com/solana-foundation/solana-developer-platform/commit/73d8611b0d0c141e4c75e80085e288c5d5047595))
* **api:** align managed reconciliation monitors ([#1453](https://github.com/solana-foundation/solana-developer-platform/pull/1453)) ([ef8be64](https://github.com/solana-foundation/solana-developer-platform/commit/ef8be643edeb9855e24dc911e82dc47f1778d954))
* **cron:** wait for working egress before running the reconciliation ticks ([#1474](https://github.com/solana-foundation/solana-developer-platform/pull/1474)) ([4531125](https://github.com/solana-foundation/solana-developer-platform/commit/45311254f3a5550dbb0735cbfcfcd8f3b99deb47))

### Documentation

* **earn:** unstale the Kamino browse-only troubleshooting rows ([#1484](https://github.com/solana-foundation/solana-developer-platform/pull/1484)) ([51b7a3d](https://github.com/solana-foundation/solana-developer-platform/commit/51b7a3d18accb334725b155ff4f6e1689875b31f))

### Refactors

* **counterparties:** rip stored pii and the bank_account kind from the contract ([#1507](https://github.com/solana-foundation/solana-developer-platform/pull/1507)) ([f98a03a](https://github.com/solana-foundation/solana-developer-platform/commit/f98a03af67bcfbe0b1e6deb098f1119148fb472d))
* **counterparties:** drop pii encryption code paths and shorten ids to cpty_ ([#1499](https://github.com/solana-foundation/solana-developer-platform/pull/1499)) ([6167803](https://github.com/solana-foundation/solana-developer-platform/commit/61678039b6f4538fbf8777d41b3855d9e50055ef))
* **counterparties:** remove pii dual writes and drop encryption code paths ([#1498](https://github.com/solana-foundation/solana-developer-platform/pull/1498)) ([98aabf3](https://github.com/solana-foundation/solana-developer-platform/commit/98aabf3a29d2765460e3e0654853e265f046a496))
* **private-channels:** move administration to integrations ([#1481](https://github.com/solana-foundation/solana-developer-platform/pull/1481)) ([c4c9ee5](https://github.com/solana-foundation/solana-developer-platform/commit/c4c9ee597d774b926c0323d3e35e5e6812070141))
* **issuance:** grid-only asset list with wallet-style cards ([#1476](https://github.com/solana-foundation/solana-developer-platform/pull/1476)) ([2e9ad92](https://github.com/solana-foundation/solana-developer-platform/commit/2e9ad921cdcad579fd37c624aa57952eb1b2d6d9))

### Maintenance

* **smoke:** canary with prod leg, Loki-reported for consecutive-failure alerting ([#1506](https://github.com/solana-foundation/solana-developer-platform/pull/1506)) ([56ff044](https://github.com/solana-foundation/solana-developer-platform/commit/56ff044629853821484ae58b31edc2725eb248a0))
* **smoke:** stop the smoke build from creating Sentry releases ([#1504](https://github.com/solana-foundation/solana-developer-platform/pull/1504)) ([b3c6f6c](https://github.com/solana-foundation/solana-developer-platform/commit/b3c6f6cfbfeaa1659b136f327a84d8fab40e3b71))
* **smoke:** gate release promotions on the dev smoke, plus a 30-minute heartbeat ([#1494](https://github.com/solana-foundation/solana-developer-platform/pull/1494)) ([d3a1bfd](https://github.com/solana-foundation/solana-developer-platform/commit/d3a1bfdcfb8336aeb94b86579bfd8a63159923f5))
* **web:** wire sdp-web unit tests into CI by renaming test:unit to test ([#1491](https://github.com/solana-foundation/solana-developer-platform/pull/1491)) ([025808c](https://github.com/solana-foundation/solana-developer-platform/commit/025808ca2ef66c57a5a2aa57da78dc2b21e7a54f))
* **counterparties:** remove the pii migration script and job wiring ([#1497](https://github.com/solana-foundation/solana-developer-platform/pull/1497)) ([d4fcba6](https://github.com/solana-foundation/solana-developer-platform/commit/d4fcba6a0a2d78eca47f0bba63d06b0e43efbf05))
* **payments:** add a feature flag for it ([#1496](https://github.com/solana-foundation/solana-developer-platform/pull/1496)) ([16b718b](https://github.com/solana-foundation/solana-developer-platform/commit/16b718b6aa75b6ec31f7db5b573b199f0c9c3adb))
* **web:** consolidate e2e bootstrap into managed session helpers ([#1478](https://github.com/solana-foundation/solana-developer-platform/pull/1478)) ([5d62c5e](https://github.com/solana-foundation/solana-developer-platform/commit/5d62c5e5dd540ab2c5419bdc50085c341bae9c96))
* **deps:** bump the solana group with 8 updates ([#1458](https://github.com/solana-foundation/solana-developer-platform/pull/1458)) ([f68941e](https://github.com/solana-foundation/solana-developer-platform/commit/f68941e4f5c9105fa106ea9a250b181f20f297bc))

## [0.67.1](https://github.com/solana-foundation/solana-developer-platform/compare/v0.67.0...v0.67.1) (2026-08-24)

### Maintenance

* **deps:** bump motion from 12.43.0 to 13.1.0 ([#1462](https://github.com/solana-foundation/solana-developer-platform/pull/1462)) ([113f015](https://github.com/solana-foundation/solana-developer-platform/commit/113f015d7646255c5389fbaf89fe411b21a042c2))

## [0.67.0](https://github.com/solana-foundation/solana-developer-platform/compare/v0.66.0...v0.67.0) (2026-08-24)

### Features

* **web:** PRO-1719 present the two Earn paths on a Markets landing page ([#1465](https://github.com/solana-foundation/solana-developer-platform/pull/1465)) ([146adfd](https://github.com/solana-foundation/solana-developer-platform/commit/146adfdba791a4e03c394562a15f2f8af307105f))
* **earn:** sponsor vault movements through Kora and give the share-ATA rent back (PRO-1736) ([#1446](https://github.com/solana-foundation/solana-developer-platform/pull/1446)) ([188486b](https://github.com/solana-foundation/solana-developer-platform/commit/188486b9ac3b6a28a45b798aa89c16a5ecd380f4))
* **earn:** add Kamino vault withdrawals ([#1439](https://github.com/solana-foundation/solana-developer-platform/pull/1439)) ([4a233db](https://github.com/solana-foundation/solana-developer-platform/commit/4a233db503dbd03be48c7ab1a4ea44268a4e67fe))
* **helius:** add the Helius Rings shielded wallet module ([#1438](https://github.com/solana-foundation/solana-developer-platform/pull/1438)) ([ac8fe3a](https://github.com/solana-foundation/solana-developer-platform/commit/ac8fe3ae949b71e4d24f0a8aaae21e3142606005))
* **payments:** cross-check Solana Pay settlement via verifyTransactionLanded ([#1431](https://github.com/solana-foundation/solana-developer-platform/pull/1431)) ([ac8564d](https://github.com/solana-foundation/solana-developer-platform/commit/ac8564d7bb262753d21e7cedd9ac310ce73be140))
* **rpc:** reusable verified-confirmation helper for on-chain writes ([#1430](https://github.com/solana-foundation/solana-developer-platform/pull/1430)) ([5e2d693](https://github.com/solana-foundation/solana-developer-platform/commit/5e2d693be19eceaaefd4d1b4dcc33582231114a3))
* **earn:** serve every Earn read from the unified ledger, settle to finalized, add the cross-provider feed (PRO-1705) ([#1409](https://github.com/solana-foundation/solana-developer-platform/pull/1409)) ([ba384bb](https://github.com/solana-foundation/solana-developer-platform/commit/ba384bb43666514696842537cfc72dc67ead01bc))

### Bug Fixes

* **rpc:** retry transient failures on signature-status and block-height reads ([#1463](https://github.com/solana-foundation/solana-developer-platform/pull/1463)) ([ed5a8e1](https://github.com/solana-foundation/solana-developer-platform/commit/ed5a8e13dd123dba565ff6a051809dc3bce1d753))
* **api:** HOO-1015 Deepsec: preserve controls during partial wallet-policy updates ([#1208](https://github.com/solana-foundation/solana-developer-platform/pull/1208)) ([a6cbf58](https://github.com/solana-foundation/solana-developer-platform/commit/a6cbf58a4d07bd9fdec3d9da14c782c7ae49e2b7))
* **rpc:** destroy the stored secret when a BYOK connection is deactivated ([#1442](https://github.com/solana-foundation/solana-developer-platform/pull/1442)) ([54bb79d](https://github.com/solana-foundation/solana-developer-platform/commit/54bb79d3458f0a728e1d48b5ec457646a4cd1adf))
* **payments:** extend durable submission to batches and recurring ([#1455](https://github.com/solana-foundation/solana-developer-platform/pull/1455)) ([d594203](https://github.com/solana-foundation/solana-developer-platform/commit/d59420375485322cd26e6f7a3164fa425fee687a))
* **payments:** persist signed transfers before broadcast ([#1454](https://github.com/solana-foundation/solana-developer-platform/pull/1454)) ([521bffb](https://github.com/solana-foundation/solana-developer-platform/commit/521bffb5795122e44cc24e68476ba4e7faeaedde))
* **custody:** fail closed on legacy custody encryption and refuse local signing from stored config ([#1441](https://github.com/solana-foundation/solana-developer-platform/pull/1441)) ([6ca4d22](https://github.com/solana-foundation/solana-developer-platform/commit/6ca4d228f99e3b140dfabf04be82a42de7699c97))
* **payments:** make the recurring detail amount label match exactly one node ([#1445](https://github.com/solana-foundation/solana-developer-platform/pull/1445)) ([ba3d10c](https://github.com/solana-foundation/solana-developer-platform/commit/ba3d10c0788474a4615ad16cbece213fad891584))
* **custody:** prohibit platform-held signing keys in managed deployments ([#1444](https://github.com/solana-foundation/solana-developer-platform/pull/1444)) ([772acee](https://github.com/solana-foundation/solana-developer-platform/commit/772aceef077a9df39c276b983595a1d0ba82a646))
* **rpc:** classify transient Solana JSON-RPC server codes as retryable ([#1432](https://github.com/solana-foundation/solana-developer-platform/pull/1432)) ([92db497](https://github.com/solana-foundation/solana-developer-platform/commit/92db497f186734790bb84227b4fac98633502a1a))
* **ci:** pin actions to commit SHAs and stop interpolating changed paths into shell ([#1404](https://github.com/solana-foundation/solana-developer-platform/pull/1404)) ([ba00967](https://github.com/solana-foundation/solana-developer-platform/commit/ba0096739e9d38616e8db27efa3f1dea6d1b8c1e))

### Documentation

* **payments:** refresh ramp provider integration skills ([#1464](https://github.com/solana-foundation/solana-developer-platform/pull/1464)) ([0de2de8](https://github.com/solana-foundation/solana-developer-platform/commit/0de2de8ad20e7f871111e6e688745d7fe16dea2a))

### Refactors

* **web:** markets landing follow-ups from post-merge review ([#1467](https://github.com/solana-foundation/solana-developer-platform/pull/1467)) ([c686d92](https://github.com/solana-foundation/solana-developer-platform/commit/c686d922f9f03ed36092e383dd798eec493caed8))
* **rpc:** use kit primitives for airdrop and commitment ordering ([#1440](https://github.com/solana-foundation/solana-developer-platform/pull/1440)) ([8e56b4f](https://github.com/solana-foundation/solana-developer-platform/commit/8e56b4f0b4283e929d476491f118ff21ce0931f1))
* **earn:** flip Earn writes to the unified ledger and retire the split tables' code (PRO-1705) ([#1410](https://github.com/solana-foundation/solana-developer-platform/pull/1410)) ([14b18be](https://github.com/solana-foundation/solana-developer-platform/commit/14b18be88d4e2087d648f2de2ccce2dda6b55a0b))

### Maintenance

* **deps:** bump the actions group across 1 directory with 4 updates ([#1466](https://github.com/solana-foundation/solana-developer-platform/pull/1466)) ([28ebc9e](https://github.com/solana-foundation/solana-developer-platform/commit/28ebc9e82951a2e2814aa5620ca01ab528455d46))
* **skills:** share agent workflows across Claude and Codex ([#1428](https://github.com/solana-foundation/solana-developer-platform/pull/1428)) ([8b0c3e7](https://github.com/solana-foundation/solana-developer-platform/commit/8b0c3e7c3dd71242913a391484c3aa7a9b9e58bf))

## [0.66.0](https://github.com/solana-foundation/solana-developer-platform/compare/v0.65.0...v0.66.0) (2026-08-20)

### Features

* **earn:** add the unified movement ledger and dual-write into it (PRO-1705) ([#1408](https://github.com/solana-foundation/solana-developer-platform/pull/1408)) ([effaa2c](https://github.com/solana-foundation/solana-developer-platform/commit/effaa2c27e7eee1b9400a9d009153bb37382e3a9))
* **helius:** Rings gateway skeleton, signed router, WalletAuthority, and container ([#1407](https://github.com/solana-foundation/solana-developer-platform/pull/1407)) ([8610d42](https://github.com/solana-foundation/solana-developer-platform/commit/8610d4283de45cab4d5a0634820fe8e4393e04ad))
* **earn:** persist an in-flight vault deposit and poll it to a terminal state ([#1399](https://github.com/solana-foundation/solana-developer-platform/pull/1399)) ([3295539](https://github.com/solana-foundation/solana-developer-platform/commit/32955395f613bbb9da35bc3d7ed0d6546dfff668))
* **web:** bring your own RPC credentials from the provider page ([#1347](https://github.com/solana-foundation/solana-developer-platform/pull/1347)) ([72e9a9b](https://github.com/solana-foundation/solana-developer-platform/commit/72e9a9b08c9753e3afefceed5c1b7d6603e08ad5))
* **api:** resolve stored RPC connections in the relay ([#1346](https://github.com/solana-foundation/solana-developer-platform/pull/1346)) ([01e524d](https://github.com/solana-foundation/solana-developer-platform/commit/01e524d6aa3ed02ca43f8865b3820aa699792459))
* **api:** persist tenant-scoped RPC connections ([#1345](https://github.com/solana-foundation/solana-developer-platform/pull/1345)) ([fa591a5](https://github.com/solana-foundation/solana-developer-platform/commit/fa591a54ce8604172b371c6c8e567be1bb820ea1))
* **api:** run the full reconciliation surface on the managed cron job (PRO-1715) ([#1403](https://github.com/solana-foundation/solana-developer-platform/pull/1403)) ([7c0e7a4](https://github.com/solana-foundation/solana-developer-platform/commit/7c0e7a4e20e5c179794fcece3893126021bc52fe))
* **api:** migrate nested custody secrets to KMS envelopes in the backfill ([#1376](https://github.com/solana-foundation/solana-developer-platform/pull/1376)) ([fb6d252](https://github.com/solana-foundation/solana-developer-platform/commit/fb6d25212a01ba96f1280359f7ffe07184162c33))
* **api:** support Custody Connections in API keys and policies(HOO-1022) ([#1336](https://github.com/solana-foundation/solana-developer-platform/pull/1336)) ([abdf145](https://github.com/solana-foundation/solana-developer-platform/commit/abdf145dd5216eead6ce57d291f802e6f1707851))
* **api:** move request-body validation to route-level middleware ([#1373](https://github.com/solana-foundation/solana-developer-platform/pull/1373)) ([76c2dfa](https://github.com/solana-foundation/solana-developer-platform/commit/76c2dfadfee6e51d710fb03315598afc39639e09))
* **web:** manage the RPC provider from its integration detail page ([#1344](https://github.com/solana-foundation/solana-developer-platform/pull/1344)) ([2f93f25](https://github.com/solana-foundation/solana-developer-platform/commit/2f93f251f078029530e008bf3a7f2ac0fbd12185))
* **web:** list custody connections on the wallets surface ([#1308](https://github.com/solana-foundation/solana-developer-platform/pull/1308)) ([8108697](https://github.com/solana-foundation/solana-developer-platform/commit/8108697fd3ec99d278e6fca5f55f392ff17b93de))

### Bug Fixes

* **payments:** finalize confirmed transfers and standardize the reconciliation job (PRO-1713) ([#1402](https://github.com/solana-foundation/solana-developer-platform/pull/1402)) ([59189ed](https://github.com/solana-foundation/solana-developer-platform/commit/59189edf4ab7ac25e828c2782ef7f6d80ec3fb1c))
* **api:** send tenant RPC egress through the address guard ([#1405](https://github.com/solana-foundation/solana-developer-platform/pull/1405)) ([6878070](https://github.com/solana-foundation/solana-developer-platform/commit/6878070e72fb9910262db7e25610b91d494e679a))

## [0.65.0](https://github.com/solana-foundation/solana-developer-platform/compare/v0.64.0...v0.65.0) (2026-08-19)

### Features

* **earn:** add Treasury Solutions with live custody balances and vault positions ([#1397](https://github.com/solana-foundation/solana-developer-platform/pull/1397)) ([9792cf9](https://github.com/solana-foundation/solana-developer-platform/commit/9792cf923e20c1d6a681a6539498a4e5b2f3e66e))

### Bug Fixes

* **web:** resolve token mints to symbols on ramp success and asset breakdown ([#1377](https://github.com/solana-foundation/solana-developer-platform/pull/1377)) ([c9cc500](https://github.com/solana-foundation/solana-developer-platform/commit/c9cc500d77cf459c375a52d701395f17caa448d8))

## [0.64.0](https://github.com/solana-foundation/solana-developer-platform/compare/v0.63.0...v0.64.0) (2026-08-19)

### Features

* **web:** add Earn vault deposit and vault position BFF routes ([#1395](https://github.com/solana-foundation/solana-developer-platform/pull/1395)) ([f9ee6dc](https://github.com/solana-foundation/solana-developer-platform/commit/f9ee6dcc827ea0ef880c1909a4810d6ab3ad9517))
* **web:** let dashboard routes forward opt-in upstream headers ([#1394](https://github.com/solana-foundation/solana-developer-platform/pull/1394)) ([b81c9f1](https://github.com/solana-foundation/solana-developer-platform/commit/b81c9f1b14ca2cf722da60d77d0bf7c0b5476307))

### Bug Fixes

* **earn:** fail closed on malformed Ground responses and blend APY exactly ([#1392](https://github.com/solana-foundation/solana-developer-platform/pull/1392)) ([68c5628](https://github.com/solana-foundation/solana-developer-platform/commit/68c56287c470178d054073acb59c42ab14cb234b))

### Refactors

* **earn:** share program envelopes and payout capability via @sdp/types ([#1391](https://github.com/solana-foundation/solana-developer-platform/pull/1391)) ([456da99](https://github.com/solana-foundation/solana-developer-platform/commit/456da99cce0af19c8f6447cb5004f6116c642381))

### Maintenance

* deploy sdp-web to prod via Vercel git integration on release merges ([#1390](https://github.com/solana-foundation/solana-developer-platform/pull/1390)) ([4286ce3](https://github.com/solana-foundation/solana-developer-platform/commit/4286ce3be9ca6540f17280c6905a098a2857ff31))
* **earn:** remove the demo seed and its catalogue delist exemption ([#1393](https://github.com/solana-foundation/solana-developer-platform/pull/1393)) ([61ac1b5](https://github.com/solana-foundation/solana-developer-platform/commit/61ac1b58fc69ba1f16c63f3dc3e57c953ffc5276))

## [0.63.0](https://github.com/solana-foundation/solana-developer-platform/compare/v0.62.0...v0.63.0) (2026-08-18)

### Features

* **api:** add policy-gated Earn vault deposits ([#1353](https://github.com/solana-foundation/solana-developer-platform/pull/1353)) ([f7b4eff](https://github.com/solana-foundation/solana-developer-platform/commit/f7b4eff9bf1fdb0ea70a45391ad5c9937e50b92f))
* **web:** move Earn onto the standard header-tab skeleton ([#1374](https://github.com/solana-foundation/solana-developer-platform/pull/1374)) ([4cea7cb](https://github.com/solana-foundation/solana-developer-platform/commit/4cea7cb42c53a8e16e4a343dae8add8fcbcda0e8))
* HOO-1018 DeepSec: enforce organization access settings and invitation binding ([#1207](https://github.com/solana-foundation/solana-developer-platform/pull/1207)) ([c1ccfc8](https://github.com/solana-foundation/solana-developer-platform/commit/c1ccfc8fa3a806b01d6e4b19ec3807e0b0d79e2d))
* **api:** add the Earn vault execution runtime ([#1352](https://github.com/solana-foundation/solana-developer-platform/pull/1352)) ([236dd40](https://github.com/solana-foundation/solana-developer-platform/commit/236dd405e5d9b577cbf88eaf2e7315b604dca380))
* **api:** add the Earn vault movement ledger ([#1351](https://github.com/solana-foundation/solana-developer-platform/pull/1351)) ([807f802](https://github.com/solana-foundation/solana-developer-platform/commit/807f802141df06b24af1eb150bca5eff29b67660))
* **earn:** add Kamino vault execution contracts ([#1350](https://github.com/solana-foundation/solana-developer-platform/pull/1350)) ([88aaab4](https://github.com/solana-foundation/solana-developer-platform/commit/88aaab4328b9b906571678c6f1bc96f07e9cf86d))
* **web:** add the guidance primitives ([#1349](https://github.com/solana-foundation/solana-developer-platform/pull/1349)) ([1e5d9fe](https://github.com/solana-foundation/solana-developer-platform/commit/1e5d9febd2a28846478c3d43e52dc7827774f4ba))
* **earn:** surface providers from one declaration and restructure the workspace into tabs ([#1340](https://github.com/solana-foundation/solana-developer-platform/pull/1340)) ([f3693f3](https://github.com/solana-foundation/solana-developer-platform/commit/f3693f3903fa91b7c77ecf88687480f3a4192d62))
* **earn:** add Kamino as a catalogue-only vault provider ([#1300](https://github.com/solana-foundation/solana-developer-platform/pull/1300)) ([8397212](https://github.com/solana-foundation/solana-developer-platform/commit/83972128e6e325ea0e3731494f519798dcf588f2))
* **earn:** sort the strategy catalogue by pool size and APY ([#1334](https://github.com/solana-foundation/solana-developer-platform/pull/1334)) ([e8e7ad5](https://github.com/solana-foundation/solana-developer-platform/commit/e8e7ad5c84f09b2c3e0f51e55e94b617a75b480e))
* **earn:** surface wallet USDC and curate strategies ([#1299](https://github.com/solana-foundation/solana-developer-platform/pull/1299)) ([f27f6f3](https://github.com/solana-foundation/solana-developer-platform/commit/f27f6f34121c51c6a08e707a179eacd00116ec5f))

### Bug Fixes

* **sponsorship:** defer the config-unavailability trip behind a consecutive-failure threshold ([#1368](https://github.com/solana-foundation/solana-developer-platform/pull/1368)) ([990e7fc](https://github.com/solana-foundation/solana-developer-platform/commit/990e7fced10e08bf4cebf38404c0d19966520d99))
* **web:** paint the route's own skeleton on cold load ([#1348](https://github.com/solana-foundation/solana-developer-platform/pull/1348)) ([400670e](https://github.com/solana-foundation/solana-developer-platform/commit/400670e19843265182b87a755c6afca26d77ec58))
* **policy:** reject unmatchable policy rules and ungate the signer check ([#1358](https://github.com/solana-foundation/solana-developer-platform/pull/1358)) ([8e5934d](https://github.com/solana-foundation/solana-developer-platform/commit/8e5934d1d55ec69cbb3843b9df3ac12399208eb3))
* **tests:** serialize the test-database reset with audit-ledger writers ([#1370](https://github.com/solana-foundation/solana-developer-platform/pull/1370)) ([8917156](https://github.com/solana-foundation/solana-developer-platform/commit/8917156d5bdbce5eba0d2eb94f02289462e07094))
* **ci:** install pnpm before the Vercel production build ([#1366](https://github.com/solana-foundation/solana-developer-platform/pull/1366)) ([24b6f1c](https://github.com/solana-foundation/solana-developer-platform/commit/24b6f1ce3d73b987240868a9a592869c0b0e5023))
* **payments:** retry connection failures and bound Kora call latency ([#1369](https://github.com/solana-foundation/solana-developer-platform/pull/1369)) ([7e1a1ae](https://github.com/solana-foundation/solana-developer-platform/commit/7e1a1aef0afea8930b14244e4a7d6e37dd1c1c99))
* **sponsorship:** auto-recover the breaker after transient Kora config outages ([#1361](https://github.com/solana-foundation/solana-developer-platform/pull/1361)) ([aab30b1](https://github.com/solana-foundation/solana-developer-platform/commit/aab30b1c128979f8ee719743a7b33bbc505110bb))
* **ci:** stage release commits off-branch so the release PR stays open ([#1357](https://github.com/solana-foundation/solana-developer-platform/pull/1357)) ([430ac73](https://github.com/solana-foundation/solana-developer-platform/commit/430ac73d3c9ebf67e31af71e1d2f43b425e1fbe7))
* **web:** mark failed and in-flight rows in the recent transactions card ([#1313](https://github.com/solana-foundation/solana-developer-platform/pull/1313)) ([8fb1e9c](https://github.com/solana-foundation/solana-developer-platform/commit/8fb1e9c49def8592ab2f7620c1b0a946914d89bf))
* **web:** swap private channels overview and playground tabs shallowly ([#1321](https://github.com/solana-foundation/solana-developer-platform/pull/1321)) ([fe20451](https://github.com/solana-foundation/solana-developer-platform/commit/fe2045150d6e0ada697bb423a3ec600b2cf1701c))
* **web:** resolve token labels in approvals amount/asset column ([#1314](https://github.com/solana-foundation/solana-developer-platform/pull/1314)) ([911509f](https://github.com/solana-foundation/solana-developer-platform/commit/911509fb0738aaa7e916612bac932ebfd8b41843))
* **api:** reuse pending approval when a recurring collection retries ([#1320](https://github.com/solana-foundation/solana-developer-platform/pull/1320)) ([33dfbcf](https://github.com/solana-foundation/solana-developer-platform/commit/33dfbcfc653187a5c0846d2c89eadc021dcdcc08))
* **web:** keep a single divider under the private channels tab strip ([#1317](https://github.com/solana-foundation/solana-developer-platform/pull/1317)) ([6a5790b](https://github.com/solana-foundation/solana-developer-platform/commit/6a5790bf87d19a1403ec6593653dafb69e1e98df))
* **web:** include SOL in the payments available balance card ([#1311](https://github.com/solana-foundation/solana-developer-platform/pull/1311)) ([7046c23](https://github.com/solana-foundation/solana-developer-platform/commit/7046c23c81978b5fd372240470e82e93cb486463))
* **web:** give wallet setup step indicator breathing room below the header ([#1310](https://github.com/solana-foundation/solana-developer-platform/pull/1310)) ([49d1090](https://github.com/solana-foundation/solana-developer-platform/commit/49d1090ee59bbbad564360e038ef5083fd2eb85d))

### Maintenance

* **deps:** bump pnpm/action-setup in the actions group ([#1367](https://github.com/solana-foundation/solana-developer-platform/pull/1367)) ([a943e82](https://github.com/solana-foundation/solana-developer-platform/commit/a943e823edf9133ff86666c0514575fac297b298))
* **deps:** bump undici override from 7.28.0 to 7.29.0 ([#1371](https://github.com/solana-foundation/solana-developer-platform/pull/1371)) ([6d7111c](https://github.com/solana-foundation/solana-developer-platform/commit/6d7111cc67a103243508a2ccab413db62d8c2bdf))
* run the Token Flows integration shard against real Kora ([#1360](https://github.com/solana-foundation/solana-developer-platform/pull/1360)) ([46ebb94](https://github.com/solana-foundation/solana-developer-platform/commit/46ebb94780c20f2eb8a884658019a1239a8c3754))

## [0.62.0](https://github.com/solana-foundation/solana-developer-platform/compare/v0.61.0...v0.62.0) (2026-08-14)

### Features

* **sponsorship:** emit structured money-path events ([#1286](https://github.com/solana-foundation/solana-developer-platform/pull/1286)) ([04102b3](https://github.com/solana-foundation/solana-developer-platform/commit/04102b3b2ddf5fc65d04c9a87a3b39f5fba9c320))
* **i18n:** add complete Vietnamese (vi) UI translation catalogs ([#1154](https://github.com/solana-foundation/solana-developer-platform/pull/1154)) ([3ecc2e3](https://github.com/solana-foundation/solana-developer-platform/commit/3ecc2e3b133e5f02d45fa4f232652f125bef5170))

### Bug Fixes

* **ci:** restore dashboard release deploys ([#1327](https://github.com/solana-foundation/solana-developer-platform/pull/1327)) ([465ed16](https://github.com/solana-foundation/solana-developer-platform/commit/465ed1669488e2c5b8aff7215e60214dcf7113cd))

### Maintenance

* **web:** general dashboard improvements ([#1324](https://github.com/solana-foundation/solana-developer-platform/pull/1324)) ([bf12555](https://github.com/solana-foundation/solana-developer-platform/commit/bf12555482b67a0e5e738b077a071620a53fb9b0))

## [0.61.0](https://github.com/solana-foundation/solana-developer-platform/compare/v0.60.0...v0.61.0) (2026-08-14)

### Features

* **policy:** author wallet transfer limits per asset (PRO-1684) ([#1306](https://github.com/solana-foundation/solana-developer-platform/pull/1306)) ([3486b68](https://github.com/solana-foundation/solana-developer-platform/commit/3486b68ceeac9e965954935e4e10cd2dbb3d5e6a))
* **helius:** add helius statemachine ([#1264](https://github.com/solana-foundation/solana-developer-platform/pull/1264)) ([dcf7b1d](https://github.com/solana-foundation/solana-developer-platform/commit/dcf7b1de7be686257974ee4387de40abdaf25436))
* **web:** deploy issuance tokens through Kora sponsorship only ([#1302](https://github.com/solana-foundation/solana-developer-platform/pull/1302)) ([eb1f07b](https://github.com/solana-foundation/solana-developer-platform/commit/eb1f07b5a37dc01b5e156da1501b31a1d4717a69))

### Bug Fixes

* **integration:** assert the reservation-ceiling invariant, not zero outflow ([#1316](https://github.com/solana-foundation/solana-developer-platform/pull/1316)) ([9ce567d](https://github.com/solana-foundation/solana-developer-platform/commit/9ce567dbd61924e6a8c5bbf29fda8442a3484b00))
* **ci:** deploy releases from protected main flow ([#1304](https://github.com/solana-foundation/solana-developer-platform/pull/1304)) ([499d02f](https://github.com/solana-foundation/solana-developer-platform/commit/499d02f4cb94e04428164bbd8549d963ca0c5014))

### Maintenance

* **deps:** bump the solana group with 5 updates ([#1231](https://github.com/solana-foundation/solana-developer-platform/pull/1231)) ([1333b70](https://github.com/solana-foundation/solana-developer-platform/commit/1333b70675e2d3de5d01cb7aa9f35263c2d5fd4f))
* **deps-dev:** bump jsdom from 26.1.0 to 30.0.1 ([#1193](https://github.com/solana-foundation/solana-developer-platform/pull/1193)) ([5f57dd3](https://github.com/solana-foundation/solana-developer-platform/commit/5f57dd3974c7e49d5edd3e2ada765449ac89b33b))

## [0.60.0](https://github.com/solana-foundation/solana-developer-platform/compare/v0.59.0...v0.60.0) (2026-08-13)

### Features

* **earn:** make the withdrawal preview the authority on available liquidity (PRO-1675) ([#1283](https://github.com/solana-foundation/solana-developer-platform/pull/1283)) ([a703867](https://github.com/solana-foundation/solana-developer-platform/commit/a703867d2e4b234a8c951b103cf453cd59088f42))
* **custody:** Add Connection wallet API parity ([#1250](https://github.com/solana-foundation/solana-developer-platform/pull/1250)) ([8fcdef0](https://github.com/solana-foundation/solana-developer-platform/commit/8fcdef0bd33ddf84be3646c655c125096825ec5c))
* **api:** add provider setup registry ([#1276](https://github.com/solana-foundation/solana-developer-platform/pull/1276)) ([6b50197](https://github.com/solana-foundation/solana-developer-platform/commit/6b501970b836bf7b8f017c91f3889002da43e332))
* enforce dynamic Kora sponsorship budgets ([#1060](https://github.com/solana-foundation/solana-developer-platform/pull/1060)) ([58e0e44](https://github.com/solana-foundation/solana-developer-platform/commit/58e0e44d0372069d9f429927823d23a808cc980d))
* **web:** surface Clerk org id in workspace switcher ([#1271](https://github.com/solana-foundation/solana-developer-platform/pull/1271)) ([540bc74](https://github.com/solana-foundation/solana-developer-platform/commit/540bc7409d6222018c1007664c6496a4c997b122))
* **web:** simplify Earn strategy selection ([#1267](https://github.com/solana-foundation/solana-developer-platform/pull/1267)) ([78242cf](https://github.com/solana-foundation/solana-developer-platform/commit/78242cf72fc13bf95f10e0c59ca4cfa6ee050655))
* **helius:** add simple dtos for helius operations ([#1241](https://github.com/solana-foundation/solana-developer-platform/pull/1241)) ([4184c3e](https://github.com/solana-foundation/solana-developer-platform/commit/4184c3ed043922574244dfc9ab4fbac3846ecea2))
* **earn:** many concurrent single-vault programs per provider (PRO-1670) ([#1256](https://github.com/solana-foundation/solana-developer-platform/pull/1256)) ([97716b6](https://github.com/solana-foundation/solana-developer-platform/commit/97716b67adb2cc2bc650fa286d6dd6167f3b66de))
* **web:** move integrations family filters into header tabs ([#1251](https://github.com/solana-foundation/solana-developer-platform/pull/1251)) ([3ff1003](https://github.com/solana-foundation/solana-developer-platform/commit/3ff1003784cc5fd863ad0fe1dd2d1dabc696236e))
* **web:** give platform.solana.com real social-card metadata ([#1253](https://github.com/solana-foundation/solana-developer-platform/pull/1253)) ([1333dba](https://github.com/solana-foundation/solana-developer-platform/commit/1333dba9497fc9930361e54588b66198efc60c99))
* **web:** install Privy from stored credentials in the setup flow ([#1126](https://github.com/solana-foundation/solana-developer-platform/pull/1126)) ([a7a076b](https://github.com/solana-foundation/solana-developer-platform/commit/a7a076b4f848906805c94553d351c13a1256efe5))
* **issuance:** Workflow Builder — event-driven automations for asset profiles (Phase 5) ([#1099](https://github.com/solana-foundation/solana-developer-platform/pull/1099)) ([912e8c9](https://github.com/solana-foundation/solana-developer-platform/commit/912e8c9e7fbbee9f629ff6011c5e11fdffca75c0))

### Bug Fixes

* **payments:** judge the fee-payer policy by its values, not by its shape ([#1295](https://github.com/solana-foundation/solana-developer-platform/pull/1295)) ([9d5f938](https://github.com/solana-foundation/solana-developer-platform/commit/9d5f938776d369a2c5e8f34060c2d2112e18524c))
* **sponsorship:** recognise the previous ownership format when admitting a retry ([#1284](https://github.com/solana-foundation/solana-developer-platform/pull/1284)) ([74290c0](https://github.com/solana-foundation/solana-developer-platform/commit/74290c0b85afcd116090c0024b3f1087d1bab791))
* **cron:** log every underlying cause of a failed reconciliation tick ([#1281](https://github.com/solana-foundation/solana-developer-platform/pull/1281)) ([a2a8484](https://github.com/solana-foundation/solana-developer-platform/commit/a2a84840107908bd7d09435bd0f2a6b7a5815022))
* **sponsorship:** close budget bypass, phantom charge, and double-count in admission ([#1280](https://github.com/solana-foundation/solana-developer-platform/pull/1280)) ([698bba5](https://github.com/solana-foundation/solana-developer-platform/commit/698bba58b37d3b307d7befe4d949a7d40ed9d012))
* **i18n:** recover stalled translation sync ([#1273](https://github.com/solana-foundation/solana-developer-platform/pull/1273)) ([a146175](https://github.com/solana-foundation/solana-developer-platform/commit/a14617582b5febc84f0e6aa66e8e7503ccd9398d))
* **api:** HOO-1004 isolate custody wallets and configuration by tenant (HOO-1004) ([#1246](https://github.com/solana-foundation/solana-developer-platform/pull/1246)) ([969e360](https://github.com/solana-foundation/solana-developer-platform/commit/969e360d0062b3f32f084dc11cd37203f802a0be))
* **earn:** list and store Solana-hosted vaults only ([#1265](https://github.com/solana-foundation/solana-developer-platform/pull/1265)) ([c6e2352](https://github.com/solana-foundation/solana-developer-platform/commit/c6e2352799361dce92fca3d2d866875ba8ab13cc))
* **sdp-web:** make clerk colorMuted opaque to stop modal navbar bleed-through ([#1257](https://github.com/solana-foundation/solana-developer-platform/pull/1257)) ([132e1d2](https://github.com/solana-foundation/solana-developer-platform/commit/132e1d2202474e0a7ca3b99cb1eb8fd56f665a3b))
* HOO-1010 Deepsec: enforce fail-closed limits on metered dashboard proxies ([#1215](https://github.com/solana-foundation/solana-developer-platform/pull/1215)) ([14ca057](https://github.com/solana-foundation/solana-developer-platform/commit/14ca057a9841cd97e6901a377981fdbf5858df2a))

### Maintenance

* remove Hacktron review configuration ([#1294](https://github.com/solana-foundation/solana-developer-platform/pull/1294)) ([7b672bf](https://github.com/solana-foundation/solana-developer-platform/commit/7b672bfd524e95fa83082f685d3d3bdb74760aed))
* promote sdp-api and sdp-web to prod on release publish ([#1248](https://github.com/solana-foundation/solana-developer-platform/pull/1248)) ([a655234](https://github.com/solana-foundation/solana-developer-platform/commit/a6552341e1435512bd1092736f4016ca8bc40ef5))

### Other Changes

* Sort Earn programs newest first ([#1270](https://github.com/solana-foundation/solana-developer-platform/pull/1270)) ([e1fc10d](https://github.com/solana-foundation/solana-developer-platform/commit/e1fc10d72ab6d36cc8f9ee7d770d2261dc5f0827))

## [0.59.0](https://github.com/solana-foundation/solana-developer-platform/compare/v0.58.0...v0.59.0) (2026-08-12)

### Features

* Runtime env connection ([#1238](https://github.com/solana-foundation/solana-developer-platform/pull/1238)) ([00ece43](https://github.com/solana-foundation/solana-developer-platform/commit/00ece43737094178734ab414dd7e3d41a419e498))
* **policy:** drop legacy payment_wallet_policies and cut over to control profiles (PRO-1617) ([#1232](https://github.com/solana-foundation/solana-developer-platform/pull/1232)) ([65bb807](https://github.com/solana-foundation/solana-developer-platform/commit/65bb807fd2bce9ee8055442e77b6046a51df9010))
* **earn:** single-vault V1 — one allocation entry per token group (PRO-1667) ([#1243](https://github.com/solana-foundation/solana-developer-platform/pull/1243)) ([b4b3478](https://github.com/solana-foundation/solana-developer-platform/commit/b4b3478b455942593443fe9edb3f8da262be571a))
* **earn:** withdrawal ledger + live-only positions — ledger vs live decided (PRO-1628) ([#1239](https://github.com/solana-foundation/solana-developer-platform/pull/1239)) ([025c7ac](https://github.com/solana-foundation/solana-developer-platform/commit/025c7acf4e44a8e6a12bcf13b495fce80ea04112))
* **helius:** add helius rings feature entry ([#1234](https://github.com/solana-foundation/solana-developer-platform/pull/1234)) ([9b287d3](https://github.com/solana-foundation/solana-developer-platform/commit/9b287d3bb1ac082d3c1c464ecbc075e47c237e9c))

## [0.58.0](https://github.com/solana-foundation/solana-developer-platform/compare/v0.57.0...v0.58.0) (2026-08-11)

### Features

* **sdp-web:** general improvements on ux ([#1221](https://github.com/solana-foundation/solana-developer-platform/pull/1221)) ([9aa7e46](https://github.com/solana-foundation/solana-developer-platform/commit/9aa7e46d73d7cbd0128f913cfc050d3e7200686a))
* **sdp-api:** run the gated Earn catalogue sync in the managed Cloud Run job (PRO-1655) ([#1211](https://github.com/solana-foundation/solana-developer-platform/pull/1211)) ([10e80a7](https://github.com/solana-foundation/solana-developer-platform/commit/10e80a7c2b23e189b59b16e6ad8ec87f06652428))
* **sdp-api:** gate ramps, transfer batches, issuance, and signer-check through policyGate (PRO-1657) ([#1209](https://github.com/solana-foundation/solana-developer-platform/pull/1209)) ([a7c9f0d](https://github.com/solana-foundation/solana-developer-platform/commit/a7c9f0d89a418de551120f7597e5848eecdde447))
* **sdp-api:** resolve session environment from the selected project (PRO-1641) ([#1204](https://github.com/solana-foundation/solana-developer-platform/pull/1204)) ([83001e8](https://github.com/solana-foundation/solana-developer-platform/commit/83001e88dc8548aec8f1aa6c4dc705ff9447bb40))
* support multiple Privy connections ([#1148](https://github.com/solana-foundation/solana-developer-platform/pull/1148)) ([debe33a](https://github.com/solana-foundation/solana-developer-platform/commit/debe33af2d5eb912689d2c9606af000d1593ee8e))

### Bug Fixes

* **api:** allow tenant callers to mutate counterparty provider data ([#1235](https://github.com/solana-foundation/solana-developer-platform/pull/1235)) ([8748ed7](https://github.com/solana-foundation/solana-developer-platform/commit/8748ed712ba758f5c0a402910f926900cb526e2b))

### Maintenance

* **deps:** bump the actions group across 1 directory with 3 updates ([#1205](https://github.com/solana-foundation/solana-developer-platform/pull/1205)) ([83883d9](https://github.com/solana-foundation/solana-developer-platform/commit/83883d9bbb86c6be40e09a77282f4f124f6eb6ca))
* **deps:** bump pino from 9.14.0 to 10.3.1 ([#1192](https://github.com/solana-foundation/solana-developer-platform/pull/1192)) ([913097d](https://github.com/solana-foundation/solana-developer-platform/commit/913097dcf1e636125fc4e13a86beb6eb33a65258))
* pin direct dependency versions ([#1225](https://github.com/solana-foundation/solana-developer-platform/pull/1225)) ([6309ad6](https://github.com/solana-foundation/solana-developer-platform/commit/6309ad67c7ca550a343f190ff0e8e2cdaa152c52))
* pin nanoid version ([#1223](https://github.com/solana-foundation/solana-developer-platform/pull/1223)) ([39b3e28](https://github.com/solana-foundation/solana-developer-platform/commit/39b3e289aa7dc8d523184f9f2e285e414e89d2e5))
* **deps:** bump nanoid from 5.1.11 to 6.0.0 ([#1191](https://github.com/solana-foundation/solana-developer-platform/pull/1191)) ([49dd02d](https://github.com/solana-foundation/solana-developer-platform/commit/49dd02de431d5116773d56760ace85289b19a097))
* **deps:** bump the solana group with 15 updates ([#1187](https://github.com/solana-foundation/solana-developer-platform/pull/1187)) ([40d651f](https://github.com/solana-foundation/solana-developer-platform/commit/40d651fbab72c3863d15d7755ca6227891d965a5))
* **deps-dev:** bump @types/node from 25.9.2 to 26.1.2 ([#1189](https://github.com/solana-foundation/solana-developer-platform/pull/1189)) ([0982541](https://github.com/solana-foundation/solana-developer-platform/commit/0982541569bf72308edb7fc33d1aa5afe231a748))
* **deps:** bump ioredis from 5.11.1 to 6.0.0 ([#1190](https://github.com/solana-foundation/solana-developer-platform/pull/1190)) ([6d0b8e1](https://github.com/solana-foundation/solana-developer-platform/commit/6d0b8e14843181c1d354d0fbc856b59930d09ddf))
* remove AlphaLedger tokenization engine code and feature flag ([#1203](https://github.com/solana-foundation/solana-developer-platform/pull/1203)) ([3eba05e](https://github.com/solana-foundation/solana-developer-platform/commit/3eba05e571c915ef4f80f7f478cc6b17e6eb068e))

## [0.57.0](https://github.com/solana-foundation/solana-developer-platform/compare/v0.56.0...v0.57.0) (2026-08-10)

### Features

* **sdp-api:** shared policyGate middleware with zero-write dry-run, piloted on transfers (PRO-1657) ([#1186](https://github.com/solana-foundation/solana-developer-platform/pull/1186)) ([8ca8d7a](https://github.com/solana-foundation/solana-developer-platform/commit/8ca8d7a61ced1efd0d9e180f12f8e75c583157bb))
* **payments:** resolve issued-token images and record mints on transfer rows ([#1139](https://github.com/solana-foundation/solana-developer-platform/pull/1139)) ([696adf8](https://github.com/solana-foundation/solana-developer-platform/commit/696adf882cb9e303cea6725017285ef860e1cf35))
* **earn:** inventory Ground catalogue coverage vs the V1 RWA promise ([#1137](https://github.com/solana-foundation/solana-developer-platform/pull/1137)) ([5d55290](https://github.com/solana-foundation/solana-developer-platform/commit/5d55290a89832c1dc1a58d4fb01c71d12b79b5f2))

### Bug Fixes

* **release:** ignore misclassified breaking footer ([aaf99ab](https://github.com/solana-foundation/solana-developer-platform/commit/aaf99ab41e86b10d82191d30adaef237a20a57bc))
* **api:** enforce recurring settlement integrity ([#1084](https://github.com/solana-foundation/solana-developer-platform/pull/1084)) ([c3485d8](https://github.com/solana-foundation/solana-developer-platform/commit/c3485d8c035d57cbd58c4058e2f4203369441459))
* **sdp-api:** bootstrap audit-ledger checkpoint when the external key is absent ([#1183](https://github.com/solana-foundation/solana-developer-platform/pull/1183)) ([dbbf525](https://github.com/solana-foundation/solana-developer-platform/commit/dbbf5257fa3389d172188cf0ef696c81c5abed22))
* **sdp-api:** normalize API-key wallet-policy bindings onto custody_wallet_id (PRO-1658) ([#1181](https://github.com/solana-foundation/solana-developer-platform/pull/1181)) ([e464e4f](https://github.com/solana-foundation/solana-developer-platform/commit/e464e4fbe06027bc330160f9cc980d44692b4677))

### Maintenance

* **sdp-api:** split payments route tests and parallelize the unit suite ([#1201](https://github.com/solana-foundation/solana-developer-platform/pull/1201)) ([4d972c7](https://github.com/solana-foundation/solana-developer-platform/commit/4d972c7b117aa20a8adee116bf02bed14b3a7d6e))
* **deps-dev:** bump @asteasolutions/zod-to-openapi from 8.5.0 to 9.1.0 ([17d7210](https://github.com/solana-foundation/solana-developer-platform/commit/17d72101589d75fe2877af1cda8e796aa6c59e93))
* **deps:** bump nanoid from 5.1.11 to 5.1.16 ([2798a80](https://github.com/solana-foundation/solana-developer-platform/commit/2798a8036181aec7eca56da3a994fbabefa2a3ce))
* **deps:** bump the minor-patch group with 47 updates ([611bd60](https://github.com/solana-foundation/solana-developer-platform/commit/611bd604e32b0c2d54eb4e00bd2db41279bc2445))

## [0.56.0](https://github.com/solana-foundation/solana-developer-platform/compare/v0.55.0...v0.56.0) (2026-08-07)

### Features

* **policy:** revision message placeholder, history revalidation, secondary wallet actions ([#1168](https://github.com/solana-foundation/solana-developer-platform/pull/1168)) ([b0d2fc3](https://github.com/solana-foundation/solana-developer-platform/commit/b0d2fc3b91f9c52b0febec9619fa8b6399e9eab5))
* **policy:** store commit messages on wallet policy revisions ([#1156](https://github.com/solana-foundation/solana-developer-platform/pull/1156)) ([95982ba](https://github.com/solana-foundation/solana-developer-platform/commit/95982ba596f8281af8dd475dd029e56e0e276e91))
* **api:** let the dashboard read its custody connections ([#1132](https://github.com/solana-foundation/solana-developer-platform/pull/1132)) ([69ea094](https://github.com/solana-foundation/solana-developer-platform/commit/69ea094dd35b525dcf2b4dda681a134cad385998))
* **web:** give the dashboard an integrations catalog ([#1128](https://github.com/solana-foundation/solana-developer-platform/pull/1128)) ([29b5904](https://github.com/solana-foundation/solana-developer-platform/commit/29b5904620214ac57015e4ead6335c1ca5600865))
* **private-channels:** enable wallet-to-wallet transfers ([#1081](https://github.com/solana-foundation/solana-developer-platform/pull/1081)) ([1dc4921](https://github.com/solana-foundation/solana-developer-platform/commit/1dc4921d254c265aea1a562e7d385af0e682c7ff))
* **spc:** update openapi spec for api playground  prerequisites ([#1108](https://github.com/solana-foundation/solana-developer-platform/pull/1108)) ([04a1037](https://github.com/solana-foundation/solana-developer-platform/commit/04a1037b2eaf2294b01bb0e80440668174883204))
* **private-channels:** redesign the Overview and reorganize navigation ([#1142](https://github.com/solana-foundation/solana-developer-platform/pull/1142)) ([a550bed](https://github.com/solana-foundation/solana-developer-platform/commit/a550bed27b462815688fea250268d63d1114a8e5))
* **private-channels:** resolve event ids to display names ([#1140](https://github.com/solana-foundation/solana-developer-platform/pull/1140)) ([12a7a5a](https://github.com/solana-foundation/solana-developer-platform/commit/12a7a5a445643c46c2dbcf780ef7c69cbeed7cad))
* **web:** give every token holding a page to open ([#1091](https://github.com/solana-foundation/solana-developer-platform/pull/1091)) ([e9bd859](https://github.com/solana-foundation/solana-developer-platform/commit/e9bd859f48e4fd2f411cd2da54f1195f667d77a3))
* **web:** end onboarding by showing what setup created ([#1123](https://github.com/solana-foundation/solana-developer-platform/pull/1123)) ([d97b1c3](https://github.com/solana-foundation/solana-developer-platform/commit/d97b1c339768b9f77ddbaea648cb65a515b02cd0))

### Bug Fixes

* **web:** hold unrouted gated custody providers at not configured ([#1163](https://github.com/solana-foundation/solana-developer-platform/pull/1163)) ([dbd32c2](https://github.com/solana-foundation/solana-developer-platform/commit/dbd32c2625c0c14df0345d138dd497645774f668))
* **web:** register integrations in the More sheet ([#1162](https://github.com/solana-foundation/solana-developer-platform/pull/1162)) ([6e12a29](https://github.com/solana-foundation/solana-developer-platform/commit/6e12a2980c210db2d75a168d52ded02444eedc49))
* **api:** match token filters against every form the ledger stores ([#1113](https://github.com/solana-foundation/solana-developer-platform/pull/1113)) ([1732f0b](https://github.com/solana-foundation/solana-developer-platform/commit/1732f0b5f9646877f13fc62abcb9de89f9abfa5c))
* **web:** stop a new organization landing on $0.00 ([#1089](https://github.com/solana-foundation/solana-developer-platform/pull/1089)) ([cbd92ed](https://github.com/solana-foundation/solana-developer-platform/commit/cbd92eda1fe5d064787fb6625464a8858a7c88f1))
* **web:** say what onboarding can actually promise about providers ([#1093](https://github.com/solana-foundation/solana-developer-platform/pull/1093)) ([0ee73b4](https://github.com/solana-foundation/solana-developer-platform/commit/0ee73b421d6b2682def074d87c9f1b1c1a153707))
* **web:** give members without setup access somewhere to go ([#1092](https://github.com/solana-foundation/solana-developer-platform/pull/1092)) ([eaf3ec4](https://github.com/solana-foundation/solana-developer-platform/commit/eaf3ec43753135c56209ea77faef617392e53b03))
* **security:** make audit ledger tamper-evident ([#1090](https://github.com/solana-foundation/solana-developer-platform/pull/1090)) ([9dc59bd](https://github.com/solana-foundation/solana-developer-platform/commit/9dc59bdb6afbedcebb7e58cba6f71dad347bc705))
* **web:** stop the filter count appearing twice on the transactions toolbar ([#1097](https://github.com/solana-foundation/solana-developer-platform/pull/1097)) ([397cae7](https://github.com/solana-foundation/solana-developer-platform/commit/397cae714b840c59423654625bafe534287f4459))
* **policy:** execute approved wallet operations ([#1096](https://github.com/solana-foundation/solana-developer-platform/pull/1096)) ([781e229](https://github.com/solana-foundation/solana-developer-platform/commit/781e229df314e78ff9f4f11e629b7bca8fa174c7))
* **web:** show token symbols in the transactions asset filter ([#1114](https://github.com/solana-foundation/solana-developer-platform/pull/1114)) ([5436c58](https://github.com/solana-foundation/solana-developer-platform/commit/5436c58e37ddc68bcf63b41974d80e6cf925f7fd))

### Maintenance

* **auth:** forward the Clerk session token instead of minting a JWT template token ([#1147](https://github.com/solana-foundation/solana-developer-platform/pull/1147)) ([32e9a97](https://github.com/solana-foundation/solana-developer-platform/commit/32e9a9754e03460d007b61fef2e6ff70485f9153))

## [0.55.0](https://github.com/solana-foundation/solana-developer-platform/compare/v0.54.0...v0.55.0) (2026-08-06)

### Features

* HOO-1019 Add custody connection runtime targets ([#1122](https://github.com/solana-foundation/solana-developer-platform/pull/1122)) ([be4fc6d](https://github.com/solana-foundation/solana-developer-platform/commit/be4fc6de7319f23871de6509d140dcc673da4138))
* **earn:** resolve Ground's withdrawal-approval gap and drop un-routable USDT surfaces ([#1134](https://github.com/solana-foundation/solana-developer-platform/pull/1134)) ([96e394b](https://github.com/solana-foundation/solana-developer-platform/commit/96e394b1387a6d08248887b885bc957d899b277d))
* **private-channels:** add authorized event feeds and details ([#1119](https://github.com/solana-foundation/solana-developer-platform/pull/1119)) ([6d798f8](https://github.com/solana-foundation/solana-developer-platform/commit/6d798f86d9642161b280966a46354281fc02ee57))
* **api:** report what custody setup an organization actually has ([#1121](https://github.com/solana-foundation/solana-developer-platform/pull/1121)) ([161b4c0](https://github.com/solana-foundation/solana-developer-platform/commit/161b4c046ecffcccd58445b5536e38d6dc4130d8))
* **earn:** rebuild the deposit flow around one strategy, no curator step ([#1110](https://github.com/solana-foundation/solana-developer-platform/pull/1110)) ([898b1df](https://github.com/solana-foundation/solana-developer-platform/commit/898b1dfa475468030f3f0517985c06cfd738ee1e))
* **web:** show every custody provider and what can be done about it ([#1120](https://github.com/solana-foundation/solana-developer-platform/pull/1120)) ([e2ce275](https://github.com/solana-foundation/solana-developer-platform/commit/e2ce275219fd50d5f52bee46395fe420f5363efa))
* **i18n:** add complete Latin American Spanish (es) UI translation catalogs ([#1047](https://github.com/solana-foundation/solana-developer-platform/pull/1047)) ([704275a](https://github.com/solana-foundation/solana-developer-platform/commit/704275a15fec637c56c19c6dc732e4ae4ff3d3fc))
* **web:** rework policy audit detail and surface wallet-control actions ([#1115](https://github.com/solana-foundation/solana-developer-platform/pull/1115)) ([c79e58f](https://github.com/solana-foundation/solana-developer-platform/commit/c79e58f75783bcd227520828369c5b9d9f395bbb))
* **web:** polish recurring payment create flow ([#1111](https://github.com/solana-foundation/solana-developer-platform/pull/1111)) ([64235fa](https://github.com/solana-foundation/solana-developer-platform/commit/64235fa58c6822473b44e3ef13b9521609fce153))

### Bug Fixes

* **web:** let workspace list cards grow so paginated tables scroll ([#1127](https://github.com/solana-foundation/solana-developer-platform/pull/1127)) ([0657632](https://github.com/solana-foundation/solana-developer-platform/commit/0657632c165d8bc14f187d45ae3db36ab43bd2c2))
* **web:** align wallet card skeleton button margin and update policy e2e flow ([#1117](https://github.com/solana-foundation/solana-developer-platform/pull/1117)) ([43bf5cb](https://github.com/solana-foundation/solana-developer-platform/commit/43bf5cb5fda2b807e766de243214d835947e1254))

### Maintenance

* **web:** track the recurring loader's grow classes ([#1130](https://github.com/solana-foundation/solana-developer-platform/pull/1130)) ([bb10ebe](https://github.com/solana-foundation/solana-developer-platform/commit/bb10ebea4427239f9fc0d40e5c63c3df90ccda9f))

## [0.54.0](https://github.com/solana-foundation/solana-developer-platform/compare/v0.53.0...v0.54.0) (2026-08-04)

### Features

* **web:** rebuild date pickers on the shadcn calendar and revamp the policy audit list ([#1101](https://github.com/solana-foundation/solana-developer-platform/pull/1101)) ([b65e884](https://github.com/solana-foundation/solana-developer-platform/commit/b65e8844688cc2d4ba8a7ca4cf9cd09c5240fc48))
* **earn:** Solana Earn module with live Ground provider (SDP Markets V1) ([#831](https://github.com/solana-foundation/solana-developer-platform/pull/831)) ([bdb6349](https://github.com/solana-foundation/solana-developer-platform/commit/bdb634917460145aaa05978def8fbaaf79f0e4bc))
* **i18n:** add complete Brazilian Portuguese (pt) UI translation catalogs ([#1046](https://github.com/solana-foundation/solana-developer-platform/pull/1046)) ([97e6697](https://github.com/solana-foundation/solana-developer-platform/commit/97e6697261a53c656c56e8596a3e89c9cbcba81a))
* **sdp-web:** add csv export to dashboard ([#962](https://github.com/solana-foundation/solana-developer-platform/pull/962)) ([ab3e095](https://github.com/solana-foundation/solana-developer-platform/commit/ab3e0955d67b0b443045b8f9546c6dd2cee0ef69))
* asset management header v2 ([#1042](https://github.com/solana-foundation/solana-developer-platform/pull/1042)) ([e01930e](https://github.com/solana-foundation/solana-developer-platform/commit/e01930eb2baed04eaf1b6a5d245375ee24a1d455))
* **private-channels:** drive tokens from WELL_KNOWN_TOKENS ([#1065](https://github.com/solana-foundation/solana-developer-platform/pull/1065)) ([04f585e](https://github.com/solana-foundation/solana-developer-platform/commit/04f585e518d57a2216b1b4a40454ee84cb03fbe0))
* **spc:** add user role to members list, remove name ([#1041](https://github.com/solana-foundation/solana-developer-platform/pull/1041)) ([78f7930](https://github.com/solana-foundation/solana-developer-platform/commit/78f7930c136ceb4544407e2d94e6e875a6043573))
* **web:** rebuild the home page around one number ([#1004](https://github.com/solana-foundation/solana-developer-platform/pull/1004)) ([21b0253](https://github.com/solana-foundation/solana-developer-platform/commit/21b0253b83d41b242c6177a8c793e1aa5aedd398))
* **i18n:** add per-locale translation context ([#1074](https://github.com/solana-foundation/solana-developer-platform/pull/1074)) ([1ec2837](https://github.com/solana-foundation/solana-developer-platform/commit/1ec283769f235b64cb0dcd323ecfac6b2eb244f1))
* **sdp-web:** open policy revision history in a drawer ([#1071](https://github.com/solana-foundation/solana-developer-platform/pull/1071)) ([3c44fa9](https://github.com/solana-foundation/solana-developer-platform/commit/3c44fa9530950986c4f47dbea263bc72bf5afb0d))
* HOO-770 Check Privy connection and provision wallet ([#1040](https://github.com/solana-foundation/solana-developer-platform/pull/1040)) ([f0e6dff](https://github.com/solana-foundation/solana-developer-platform/commit/f0e6dff23cdc11d19ffb289966301df4fe799519))

### Bug Fixes

* **earn:** seed one portfolio wallet per org and stop chain labels leaking ([#1106](https://github.com/solana-foundation/solana-developer-platform/pull/1106)) ([4df7c0d](https://github.com/solana-foundation/solana-developer-platform/commit/4df7c0d9b86a9db7de3dae9180e881cf676a6172))
* **payments:** verify and serialize ramp settlement events ([#1085](https://github.com/solana-foundation/solana-developer-platform/pull/1085)) ([45fd40c](https://github.com/solana-foundation/solana-developer-platform/commit/45fd40c2937c08c388a6d3e8621af5ecb1bd07b2))
* **security:** close product alert backlog ([#1086](https://github.com/solana-foundation/solana-developer-platform/pull/1086)) ([5336fc1](https://github.com/solana-foundation/solana-developer-platform/commit/5336fc11e1a93583e9ea207c6c7f2d6211018083))
* skeleton route ([#1079](https://github.com/solana-foundation/solana-developer-platform/pull/1079)) ([bba2297](https://github.com/solana-foundation/solana-developer-platform/commit/bba2297ca6e584846b383e515eaa79eb28eda758))

### Documentation

* **web:** correct sdp-web README tech stack and source paths ([#1063](https://github.com/solana-foundation/solana-developer-platform/pull/1063)) ([dda331d](https://github.com/solana-foundation/solana-developer-platform/commit/dda331dab7c36f70ba57f45e854e6220ff430978))
* correct public API endpoint URL in @sdp/types README ([#1062](https://github.com/solana-foundation/solana-developer-platform/pull/1062)) ([430788e](https://github.com/solana-foundation/solana-developer-platform/commit/430788ea28dda06b7b7859651ead3416e9663793))

### Maintenance

* **api:** prove value-moving authorization and replay safety ([#1087](https://github.com/solana-foundation/solana-developer-platform/pull/1087)) ([a5894f8](https://github.com/solana-foundation/solana-developer-platform/commit/a5894f8479d1d0bd8bf6a957db40a7a8392a995f))
* **deps:** bump hono from 4.12.29 to 4.12.34 ([#1068](https://github.com/solana-foundation/solana-developer-platform/pull/1068)) ([246a9fc](https://github.com/solana-foundation/solana-developer-platform/commit/246a9fca52f5d85964e4817220a1938a215f3fdb))

## [0.53.0](https://github.com/solana-foundation/solana-developer-platform/compare/v0.52.0...v0.53.0) (2026-08-04)

### Features

* **sdp-web:** move token/RPC actions off the playground proxy ([#1064](https://github.com/solana-foundation/solana-developer-platform/pull/1064)) ([ce25f00](https://github.com/solana-foundation/solana-developer-platform/commit/ce25f0043184f1a69f43c3f247444901e175ca7d))
* **sdp-api:** add the Dry-Run request header (PRO-1618) ([#1050](https://github.com/solana-foundation/solana-developer-platform/pull/1050)) ([dc13fab](https://github.com/solana-foundation/solana-developer-platform/commit/dc13faba875ef08c79be136ff0b795ce92f075e5))
* use turbopack instead of webpack ([#1043](https://github.com/solana-foundation/solana-developer-platform/pull/1043)) ([ef57340](https://github.com/solana-foundation/solana-developer-platform/commit/ef573405213bfc569707ba1d70ce06adf36ddb33))
* **sdp-web:** PART 1 stepped tokenization-engine chooser in the deploy modal ([#1039](https://github.com/solana-foundation/solana-developer-platform/pull/1039)) ([20d7832](https://github.com/solana-foundation/solana-developer-platform/commit/20d783239447139fef559e679c5e5d3a686edb9d))
* support solana-private-channels ([#970](https://github.com/solana-foundation/solana-developer-platform/pull/970)) ([90520ef](https://github.com/solana-foundation/solana-developer-platform/commit/90520ef093b16c24081c94dec60c49532da7011e))
* **sdp-web:** vercel flag standardization ([#1035](https://github.com/solana-foundation/solana-developer-platform/pull/1035)) ([186bf21](https://github.com/solana-foundation/solana-developer-platform/commit/186bf215337a64c365aa892171fc0994f2472a8a))
* **web:** sync API playground with public OpenAPI ([#936](https://github.com/solana-foundation/solana-developer-platform/pull/936)) ([4ca03ca](https://github.com/solana-foundation/solana-developer-platform/commit/4ca03cadce86f92cd78990614ec6efa4baa69b5b))

### Bug Fixes

* **i18n:** stop translation sync after Eve result ([#814](https://github.com/solana-foundation/solana-developer-platform/pull/814)) ([3555894](https://github.com/solana-foundation/solana-developer-platform/commit/3555894cd77d2de5ad00952c677a016245b7be66))
* **i18n:** sign automated translation commits ([#1066](https://github.com/solana-foundation/solana-developer-platform/pull/1066)) ([10b672c](https://github.com/solana-foundation/solana-developer-platform/commit/10b672ca46b6aa62fa0ff68a655001ffa1b74ef2))
* **api:** enforce scoped Kora sponsorship quotas ([#1030](https://github.com/solana-foundation/solana-developer-platform/pull/1030)) ([3f74b78](https://github.com/solana-foundation/solana-developer-platform/commit/3f74b78ad191a3501a85d5276aa2b54f4ba9a5d5))
* **api:** enforce tenant-scoped data access ([#1032](https://github.com/solana-foundation/solana-developer-platform/pull/1032)) ([66ec82f](https://github.com/solana-foundation/solana-developer-platform/commit/66ec82f5fdc6a61b5985e16ab14ee698a82dbad7))
* **ci:** stabilize Surfpool RPC setup ([#1051](https://github.com/solana-foundation/solana-developer-platform/pull/1051)) ([3d52590](https://github.com/solana-foundation/solana-developer-platform/commit/3d5259017b80f63b1005e9a43a2f514d89df8c88))
* **deps:** remediate 32 runtime Dependabot alerts ([#1031](https://github.com/solana-foundation/solana-developer-platform/pull/1031)) ([a22bc15](https://github.com/solana-foundation/solana-developer-platform/commit/a22bc15fd98b411c298837d8ce3330b0dc474f84))

### Refactors

* **policy:** extract the wallet/policy engine into @sdp/policy ([#1058](https://github.com/solana-foundation/solana-developer-platform/pull/1058)) ([d923dc8](https://github.com/solana-foundation/solana-developer-platform/commit/d923dc8cb9a25b425e95d2fa67ecc1873a483953))

### Maintenance

* **deps:** bump the actions group with 2 updates ([#1057](https://github.com/solana-foundation/solana-developer-platform/pull/1057)) ([f222d54](https://github.com/solana-foundation/solana-developer-platform/commit/f222d544d55fda7a419ac21d38937681f5a17dfd))

## [0.52.0](https://github.com/solana-foundation/solana-developer-platform/compare/v0.51.0...v0.52.0) (2026-07-31)

### Features

* **sdp-web:** standardize policy layout ([#1013](https://github.com/solana-foundation/solana-developer-platform/pull/1013)) ([ef26f40](https://github.com/solana-foundation/solana-developer-platform/commit/ef26f40403da18b3d2e4980750fd36cf56d051da))

### Bug Fixes

* **sdp-web:** repair policy search and table responsiveness ([#1027](https://github.com/solana-foundation/solana-developer-platform/pull/1027)) ([6dd9581](https://github.com/solana-foundation/solana-developer-platform/commit/6dd958112909ce8b9f825989c53fb35dc63b3990))
* **i18n:** improve French translation quality and automation context ([#1022](https://github.com/solana-foundation/solana-developer-platform/pull/1022)) ([32b4d7d](https://github.com/solana-foundation/solana-developer-platform/commit/32b4d7d2d150108279fd758a9de2ad79077e6f17))

### Maintenance

* **deps:** bump the actions group across 1 directory with 2 updates ([#955](https://github.com/solana-foundation/solana-developer-platform/pull/955)) ([e738a57](https://github.com/solana-foundation/solana-developer-platform/commit/e738a5759ae92f3e05d95a5055a149a958efe635))

## [0.51.0](https://github.com/solana-foundation/solana-developer-platform/compare/v0.50.1...v0.51.0) (2026-07-31)

### Features

* **web:** replace the mobile drawer with a bottom bar and More sheet ([#1008](https://github.com/solana-foundation/solana-developer-platform/pull/1008)) ([eeea224](https://github.com/solana-foundation/solana-developer-platform/commit/eeea2246e8e7d7b90f6db0f6623564a2b8cd45eb))
* **sdp-web:** standardize header and tabbed headers title ([#1006](https://github.com/solana-foundation/solana-developer-platform/pull/1006)) ([9c9ad77](https://github.com/solana-foundation/solana-developer-platform/commit/9c9ad7759e6af2138c399ad81cead39c1ae5b497))
* **api:** structured JSON logging for sdp-api + noConsole gate ([#993](https://github.com/solana-foundation/solana-developer-platform/pull/993)) ([ed427f1](https://github.com/solana-foundation/solana-developer-platform/commit/ed427f1106dd1abbd768403663da22723fa2aac0))

### Bug Fixes

* show a real email in the member directory, and name the row when there isn't one ([#999](https://github.com/solana-foundation/solana-developer-platform/pull/999)) ([dc51fa4](https://github.com/solana-foundation/solana-developer-platform/commit/dc51fa44b7d75987c176e6d1330252747d400130))
* **web:** say which policy rule denied a wallet action ([#1011](https://github.com/solana-foundation/solana-developer-platform/pull/1011)) ([953147d](https://github.com/solana-foundation/solana-developer-platform/commit/953147da34daba4c8d5b3b6756d65aa9353442e5))
* **web:** show a new payment request's details without reopening it ([#1001](https://github.com/solana-foundation/solana-developer-platform/pull/1001)) ([b1999cb](https://github.com/solana-foundation/solana-developer-platform/commit/b1999cb4c30a70d56c0ce76771fd9c23046af06d))
* **web:** stop selected-card focus rings offsetting against white in dark mode ([#1002](https://github.com/solana-foundation/solana-developer-platform/pull/1002)) ([4482c9c](https://github.com/solana-foundation/solana-developer-platform/commit/4482c9cf8d97dfa59bcbe8c3a1dc29b43a72a8c6))
* **web:** point custody explorer links at the active cluster ([#998](https://github.com/solana-foundation/solana-developer-platform/pull/998)) ([7245f55](https://github.com/solana-foundation/solana-developer-platform/commit/7245f55e139f5d06e5e4f202ef05398579dcebcd))
* **web:** let settings use its width properly ([#1005](https://github.com/solana-foundation/solana-developer-platform/pull/1005)) ([6f0ae25](https://github.com/solana-foundation/solana-developer-platform/commit/6f0ae25c9ccce46aec8a74c8e5e38d6123e52ade))
* **web:** draw the dashboard shell while the session resolves ([#1010](https://github.com/solana-foundation/solana-developer-platform/pull/1010)) ([2b2bca2](https://github.com/solana-foundation/solana-developer-platform/commit/2b2bca22077f4f8c79b5cdfebfba83d16d3c7395))
* prevent cross-tenant custody wallet binding ([#979](https://github.com/solana-foundation/solana-developer-platform/pull/979)) ([9372354](https://github.com/solana-foundation/solana-developer-platform/commit/93723543270a3ea14406866d171e7959d96b8ccd))

### Performance Improvements

* **web:** stop pages minting a second Clerk token per request ([#1012](https://github.com/solana-foundation/solana-developer-platform/pull/1012)) ([22fc8c0](https://github.com/solana-foundation/solana-developer-platform/commit/22fc8c01b2ea0c0f68ff9f05c3c4522b54adb6a6))

## [0.50.1](https://github.com/solana-foundation/solana-developer-platform/compare/v0.50.0...v0.50.1) (2026-07-30)

### Bug Fixes

* **release:** patch npm in runtime images ([#997](https://github.com/solana-foundation/solana-developer-platform/pull/997)) ([4f3ee87](https://github.com/solana-foundation/solana-developer-platform/commit/4f3ee876b153af70e18e8cab0f32cab76e29a0ae))

## [0.50.0](https://github.com/solana-foundation/solana-developer-platform/compare/v0.49.1...v0.50.0) (2026-07-29)

### Features

* deploy with wallet for asset profiles ([#994](https://github.com/solana-foundation/solana-developer-platform/pull/994)) ([2062faa](https://github.com/solana-foundation/solana-developer-platform/commit/2062faae438240008c43f9e2e5d00af431628b91))
* **api:** price wallet balances from Jupiter before falling back to Helius ([#978](https://github.com/solana-foundation/solana-developer-platform/pull/978)) ([3cd7ce5](https://github.com/solana-foundation/solana-developer-platform/commit/3cd7ce5e0ba51e529b422919ff0ce12b9726b21c))
* **issuance:** server-driven asset list, shared overview hero, lock supply ([#983](https://github.com/solana-foundation/solana-developer-platform/pull/983)) ([9ef4a20](https://github.com/solana-foundation/solana-developer-platform/commit/9ef4a203ca8ffcdee94fe49a5fc898dc93fd7069))
* **api:** encrypt counterparty PII at rest ([#932](https://github.com/solana-foundation/solana-developer-platform/pull/932)) ([7a74d8c](https://github.com/solana-foundation/solana-developer-platform/commit/7a74d8c0d47d529e6acf75a8819e42cbd0e17b8d))
* **web:** wallet policy authoring rework + allow/blocklist storage fix ([#982](https://github.com/solana-foundation/solana-developer-platform/pull/982)) ([3e81e77](https://github.com/solana-foundation/solana-developer-platform/commit/3e81e770b6ba610e5d9040d8a17142033c779d48))
* **web:** name org-issued tokens across the dashboard ([#974](https://github.com/solana-foundation/solana-developer-platform/pull/974)) ([7bd137c](https://github.com/solana-foundation/solana-developer-platform/commit/7bd137c8eae5ba1cd3ff9185287ec2c40aaa93ef))

### Bug Fixes

* **web:** shallow tab routing in issuance token workspaces ([#971](https://github.com/solana-foundation/solana-developer-platform/pull/971)) ([af4030f](https://github.com/solana-foundation/solana-developer-platform/commit/af4030f97eadadd9a2c9f4a6c04dc809fc7bc4ad))
* **api:** stop unsubstituted Clerk placeholders rendering as the actor ([#976](https://github.com/solana-foundation/solana-developer-platform/pull/976)) ([60a5f66](https://github.com/solana-foundation/solana-developer-platform/commit/60a5f665da955d43e81794bbb9e2e33f4931f0da))
* **web:** guard playground field mapping against prototype pollution ([#926](https://github.com/solana-foundation/solana-developer-platform/pull/926)) ([bfa6fe4](https://github.com/solana-foundation/solana-developer-platform/commit/bfa6fe4ca823f923ba5751628c3956bb5cfd90a7))

### Documentation

* **security:** tighten Hacktron Playground review context ([#987](https://github.com/solana-foundation/solana-developer-platform/pull/987)) ([3ca64ec](https://github.com/solana-foundation/solana-developer-platform/commit/3ca64ec75e0f63cb7b8e68d94f094db1c4b1970d))

## [0.49.1](https://github.com/solana-foundation/solana-developer-platform/compare/v0.49.0...v0.49.1) (2026-07-28)

### Bug Fixes

* **api:** ignore and repair Clerk identity emails holding a template placeholder ([#977](https://github.com/solana-foundation/solana-developer-platform/pull/977)) ([af8d64f](https://github.com/solana-foundation/solana-developer-platform/commit/af8d64ffb8d0d58d7424ff5e91ec2cbff15baad6))

## [0.49.0](https://github.com/solana-foundation/solana-developer-platform/compare/v0.48.0...v0.49.0) (2026-07-28)

### Features

* **issuance:** AlphaLedger provider scaffold ([#967](https://github.com/solana-foundation/solana-developer-platform/pull/967)) ([23ade96](https://github.com/solana-foundation/solana-developer-platform/commit/23ade964d3b2d6ce77cb6f6f7bfd8eb0f5f600f0))
* HOO-769 Submit stored privy credentials ([#884](https://github.com/solana-foundation/solana-developer-platform/pull/884)) ([52e9ae3](https://github.com/solana-foundation/solana-developer-platform/commit/52e9ae328789eaf9aa5c6e6f93880415e979b599))
* **web:** AlphaLedger integration for tokenization ([#965](https://github.com/solana-foundation/solana-developer-platform/pull/965)) ([42e731e](https://github.com/solana-foundation/solana-developer-platform/commit/42e731edb8cba9528f88dda4fb15fb8f37de8334))
* **members:** members management on the settings page ([#946](https://github.com/solana-foundation/solana-developer-platform/pull/946)) ([e154244](https://github.com/solana-foundation/solana-developer-platform/commit/e154244a3e0d84c73b343b4a65dd0279be1078cd))
* **api:** members pagination, invitation links, revoke, and removal guards ([#945](https://github.com/solana-foundation/solana-developer-platform/pull/945)) ([071fb63](https://github.com/solana-foundation/solana-developer-platform/commit/071fb6384c1e69ea31a77b8c422d397ba042dc58))
* backend for allowlist filters/pagination and transactions filters/pagination ([#934](https://github.com/solana-foundation/solana-developer-platform/pull/934)) ([d944673](https://github.com/solana-foundation/solana-developer-platform/commit/d9446734f72b9bb4f0d48c1df22e5d585c6672b2))
* **payments:** let the transactions table show observed on-chain deposits ([#943](https://github.com/solana-foundation/solana-developer-platform/pull/943)) ([b359673](https://github.com/solana-foundation/solana-developer-platform/commit/b3596734f961711a0b6b7af46040507086447ab6))
* **types:** broaden the well-known token catalogue ([#939](https://github.com/solana-foundation/solana-developer-platform/pull/939)) ([4532cf7](https://github.com/solana-foundation/solana-developer-platform/commit/4532cf751d91a1fe45ea4da361b198868071432e))

### Bug Fixes

* **web:** break sign-in loop for sessions without an active organization ([#969](https://github.com/solana-foundation/solana-developer-platform/pull/969)) ([c62f44c](https://github.com/solana-foundation/solana-developer-platform/commit/c62f44c5d99b254e3cd61870e0c658d930a6edbf))
* **web:** move the colour theme control into settings ([#961](https://github.com/solana-foundation/solana-developer-platform/pull/961)) ([4f92f79](https://github.com/solana-foundation/solana-developer-platform/commit/4f92f791e6dc9686bcc43e3499ec736d0b502c87))

### Maintenance

* **api:** guard batch transfer destination-allowlist enforcement ([#777](https://github.com/solana-foundation/solana-developer-platform/pull/777)) ([9bf8c66](https://github.com/solana-foundation/solana-developer-platform/commit/9bf8c669b0a79ddabdc4d3028bea46a4d923b5ac))

## [0.48.0](https://github.com/solana-foundation/solana-developer-platform/compare/v0.47.1...v0.48.0) (2026-07-27)

### Features

* add Nodit RPC provider ([#924](https://github.com/solana-foundation/solana-developer-platform/pull/924)) ([6991a68](https://github.com/solana-foundation/solana-developer-platform/commit/6991a68c725909f6c477a1fb132263533e85a28a))
* **web:** ramp memo as optional wizard step with view-summary modal ([#951](https://github.com/solana-foundation/solana-developer-platform/pull/951)) ([e4b00db](https://github.com/solana-foundation/solana-developer-platform/commit/e4b00db57893074029d24b9a897f70b02b2a7cc8))
* free-form key-value rampsMemo on ramp quote transfers ([#916](https://github.com/solana-foundation/solana-developer-platform/pull/916)) ([5412c72](https://github.com/solana-foundation/solana-developer-platform/commit/5412c72c7169fc43c7de6ef4a07af05b36e9b537))
* **shell:** give sidebar sub-nav items their own icons ([#941](https://github.com/solana-foundation/solana-developer-platform/pull/941)) ([e6eb6cb](https://github.com/solana-foundation/solana-developer-platform/commit/e6eb6cb40c3ef266468db39839d2f66b19a2c391))

### Bug Fixes

* **api:** report the reason Clerk rejected a request ([#944](https://github.com/solana-foundation/solana-developer-platform/pull/944)) ([dc82f0d](https://github.com/solana-foundation/solana-developer-platform/commit/dc82f0dd5b13a5cf62f1c4de1448ad62fb50b1fc))
* **scripts:** strip surrounding quotes when overlaying .env.local ([#937](https://github.com/solana-foundation/solana-developer-platform/pull/937)) ([a58d725](https://github.com/solana-foundation/solana-developer-platform/commit/a58d72588fcc979fccfa265662eb5f75109b8df2))
* **types:** declare USDG under the Token-2022 program ([#938](https://github.com/solana-foundation/solana-developer-platform/pull/938)) ([3bfa878](https://github.com/solana-foundation/solana-developer-platform/commit/3bfa87861a9cd735898eac8ab90935c7b1e64750))
* **api:** harden CORS origin matching against regex bypass ([#925](https://github.com/solana-foundation/solana-developer-platform/pull/925)) ([c2eb344](https://github.com/solana-foundation/solana-developer-platform/commit/c2eb344bc8bd2645fb137b2bdda640bac5521a2f))
* **web:** prevent API key menu layout shift ([#931](https://github.com/solana-foundation/solana-developer-platform/pull/931)) ([610c7b1](https://github.com/solana-foundation/solana-developer-platform/commit/610c7b1d09ad8e43c443e02eda67e36bbaa8a491))
* **payments:** stop the Activity card stretching into dead space ([#918](https://github.com/solana-foundation/solana-developer-platform/pull/918)) ([348e950](https://github.com/solana-foundation/solana-developer-platform/commit/348e95064e2d9e5b2864d87de08e2db4b9542105))
* **shell:** make the sidebar collapse toggle visible and stop rail overflow ([#921](https://github.com/solana-foundation/solana-developer-platform/pull/921)) ([8ef540e](https://github.com/solana-foundation/solana-developer-platform/commit/8ef540e742321383073888765c63efdc24375dd2))
* **settings:** use the design-system Select for the RPC provider field ([#919](https://github.com/solana-foundation/solana-developer-platform/pull/919)) ([807a038](https://github.com/solana-foundation/solana-developer-platform/commit/807a0387a50475c91812ce630340f3054652eff1))
* **payments:** point explorer links at the active cluster ([#917](https://github.com/solana-foundation/solana-developer-platform/pull/917)) ([eb4ba6b](https://github.com/solana-foundation/solana-developer-platform/commit/eb4ba6b7ece1c8647e0f34551830bfa50ad68039))
* **payments:** point explorer links at the active cluster ([#917](https://github.com/solana-foundation/solana-developer-platform/pull/917)) ([bd59e4e](https://github.com/solana-foundation/solana-developer-platform/commit/bd59e4e3faef2f63f9879147f468f1c7817efe0a))
* **playground:** give the un-run Response tab a real empty state ([#922](https://github.com/solana-foundation/solana-developer-platform/pull/922)) ([da3e730](https://github.com/solana-foundation/solana-developer-platform/commit/da3e73089ca486e3119487353664674c8bb2f5d0))

### Maintenance

* **api:** remove dead sessions KV store ([#915](https://github.com/solana-foundation/solana-developer-platform/pull/915)) ([c9e6e67](https://github.com/solana-foundation/solana-developer-platform/commit/c9e6e674a2ea990bcccec9180329868550bc937b))

## [0.47.1](https://github.com/solana-foundation/solana-developer-platform/compare/v0.47.0...v0.47.1) (2026-07-24)

### Bug Fixes

* **api:** revoke stale organization sessions ([#896](https://github.com/solana-foundation/solana-developer-platform/pull/896)) ([cbcb084](https://github.com/solana-foundation/solana-developer-platform/commit/cbcb084ae90612c8769defa4033705f5e140f891))
* **custody:** trust only server provider endpoints ([#902](https://github.com/solana-foundation/solana-developer-platform/pull/902)) ([d00495c](https://github.com/solana-foundation/solana-developer-platform/commit/d00495cefbe0c1d95048a220ef425714a37e9b8d))
* **security:** isolate playground API keys by project ([#901](https://github.com/solana-foundation/solana-developer-platform/pull/901)) ([9955824](https://github.com/solana-foundation/solana-developer-platform/commit/995582428cd6c3d648f38fd8d3a45ef9370f0eb7))
* **api:** authorize all MagicBlock custody signers ([#898](https://github.com/solana-foundation/solana-developer-platform/pull/898)) ([0ab0fb5](https://github.com/solana-foundation/solana-developer-platform/commit/0ab0fb54b3812b7b4784f650a728c4401513f99a))

## [0.47.0](https://github.com/solana-foundation/solana-developer-platform/compare/v0.46.4...v0.47.0) (2026-07-24)

### Features

* issuance ui improvements and compliance tab gating ([#903](https://github.com/solana-foundation/solana-developer-platform/pull/903)) ([469400b](https://github.com/solana-foundation/solana-developer-platform/commit/469400b0e561a718108f3412bb899f1b9d55674b))
* **web:** move product rollouts to Vercel Flags ([#894](https://github.com/solana-foundation/solana-developer-platform/pull/894)) ([3c578f1](https://github.com/solana-foundation/solana-developer-platform/commit/3c578f1a8d31937845722d89e9aea2ea3a4d7484))

### Bug Fixes

* **api:** enforce API key rotation deadlines ([#897](https://github.com/solana-foundation/solana-developer-platform/pull/897)) ([6a1130b](https://github.com/solana-foundation/solana-developer-platform/commit/6a1130ba4ff2db87ee20d5ee4668e8a17b920911))
* **api:** enforce API key project isolation ([#899](https://github.com/solana-foundation/solana-developer-platform/pull/899)) ([eebea25](https://github.com/solana-foundation/solana-developer-platform/commit/eebea25eb9156518035ab6c473d3b650f41946ae))
* **api:** enforce API key IP allowlists ([#895](https://github.com/solana-foundation/solana-developer-platform/pull/895)) ([fee986b](https://github.com/solana-foundation/solana-developer-platform/commit/fee986ba1b25adea9b28df232042ffdaff9dac9a))
* **web:** clarify onboarding choices can change ([#905](https://github.com/solana-foundation/solana-developer-platform/pull/905)) ([c9d753c](https://github.com/solana-foundation/solana-developer-platform/commit/c9d753cf8d133eb62e18fc456462d635b22f1b69))

## [0.46.4](https://github.com/solana-foundation/solana-developer-platform/compare/v0.46.3...v0.46.4) (2026-07-23)

### Refactors

* **approvals:** design-system filters and date-range presets ([#886](https://github.com/solana-foundation/solana-developer-platform/pull/886)) ([6b5c525](https://github.com/solana-foundation/solana-developer-platform/commit/6b5c52568156fe1571e899d3fd155fcf23adebdd))

## [0.46.3](https://github.com/solana-foundation/solana-developer-platform/compare/v0.46.2...v0.46.3) (2026-07-23)

### Bug Fixes

* **ci:** probe private Cloud Run candidate safely ([#891](https://github.com/solana-foundation/solana-developer-platform/pull/891)) ([fff1eee](https://github.com/solana-foundation/solana-developer-platform/commit/fff1eeee14f687c4234f7a310f05da221faf5e7d))

## [0.46.2](https://github.com/solana-foundation/solana-developer-platform/compare/v0.46.1...v0.46.2) (2026-07-23)

### Bug Fixes

* **policies:** stabilize search input and polish controls layout ([#885](https://github.com/solana-foundation/solana-developer-platform/pull/885)) ([4d659b1](https://github.com/solana-foundation/solana-developer-platform/commit/4d659b16cba4230afa07bd07169075d2bf87bcef))

### Other Changes

* Backfill existing organizations as enterprise approved ([#888](https://github.com/solana-foundation/solana-developer-platform/pull/888)) ([cb7ef8a](https://github.com/solana-foundation/solana-developer-platform/commit/cb7ef8a89e135c3538d427511a04b9e801e269f3))

## [0.46.1](https://github.com/solana-foundation/solana-developer-platform/compare/v0.46.0...v0.46.1) (2026-07-23)

### Bug Fixes

* **api:** enforce per-key rate limit tiers after auth ([#855](https://github.com/solana-foundation/solana-developer-platform/pull/855)) ([a7890f8](https://github.com/solana-foundation/solana-developer-platform/commit/a7890f8fee3a6cca611168b4330fdfc505f808a4))

### Maintenance

* **deps:** bump next from 16.2.7 to 16.2.11 ([#872](https://github.com/solana-foundation/solana-developer-platform/pull/872)) ([5dfdb6b](https://github.com/solana-foundation/solana-developer-platform/commit/5dfdb6bb1946130ad8709aa2a97a51088df34710))

## [0.46.0](https://github.com/solana-foundation/solana-developer-platform/compare/v0.45.0...v0.46.0) (2026-07-23)

### Features

* updates on issuance workspace and asset management UI ([#874](https://github.com/solana-foundation/solana-developer-platform/pull/874)) ([4163068](https://github.com/solana-foundation/solana-developer-platform/commit/4163068e03241f58f33320b505a022508300ae5b))
* add the debug panel to local dev ([#875](https://github.com/solana-foundation/solana-developer-platform/pull/875)) ([6bcb1d1](https://github.com/solana-foundation/solana-developer-platform/commit/6bcb1d1b8085c73b564e4f2d40da483e01a75b39))

### Performance Improvements

* async confirmation + parallel chunks for transfer batches ([#878](https://github.com/solana-foundation/solana-developer-platform/pull/878)) ([0442373](https://github.com/solana-foundation/solana-developer-platform/commit/0442373fd23538c8f7f5752c9141a3ce871a34d6))

### Refactors

* **kv:** inline the single-runtime KV factory into kv-redis ([#880](https://github.com/solana-foundation/solana-developer-platform/pull/880)) ([4ed7455](https://github.com/solana-foundation/solana-developer-platform/commit/4ed74553b1048149363a40edf2a3487923ec9c51))

## [0.45.0](https://github.com/solana-foundation/solana-developer-platform/compare/v0.44.0...v0.45.0) (2026-07-23)

### Features

* support business counterparties on Lightspark on-ramp ([#873](https://github.com/solana-foundation/solana-developer-platform/pull/873)) ([4094f81](https://github.com/solana-foundation/solana-developer-platform/commit/4094f81676bb4b94274aa2baa91da0fe8ef0c456))
* add organization provider onboarding ([#844](https://github.com/solana-foundation/solana-developer-platform/pull/844)) ([496ac56](https://github.com/solana-foundation/solana-developer-platform/commit/496ac56a0b9b15ceeb2d4b7a7d7c32b4cd299efa))
* compliance advanced settings ui improvements ([#861](https://github.com/solana-foundation/solana-developer-platform/pull/861)) ([e24451e](https://github.com/solana-foundation/solana-developer-platform/commit/e24451e2865a823f13c3c2959d25c1efc6a2eb1a))
* **HOO-856:** move custody master key from plaintext env var to KMS envelope encryption ([#812](https://github.com/solana-foundation/solana-developer-platform/pull/812)) ([0d162f4](https://github.com/solana-foundation/solana-developer-platform/commit/0d162f402f3a73c4cd5ec94f71e9e58c5e73b0fa))

### Bug Fixes

* simplify API key wizard progress ([#869](https://github.com/solana-foundation/solana-developer-platform/pull/869)) ([2a4ac34](https://github.com/solana-foundation/solana-developer-platform/commit/2a4ac3496a58dd6bb8b2b26860f9bb8e0cc85588))
* resolve boolean query param parsing and allow cancelling pending_activation recurring payments ([#789](https://github.com/solana-foundation/solana-developer-platform/pull/789)) ([87dac13](https://github.com/solana-foundation/solana-developer-platform/commit/87dac130b34658a1e2bee8621ca74c9b3d6e36df))
* **api:** close DeepSec high-severity findings ([#848](https://github.com/solana-foundation/solana-developer-platform/pull/848)) ([68fe35d](https://github.com/solana-foundation/solana-developer-platform/commit/68fe35d3e4fd2036e8f7b649b74e53f5ddbf1188))

### Maintenance

* **deps:** bump the actions group across 1 directory with 10 updates ([#728](https://github.com/solana-foundation/solana-developer-platform/pull/728)) ([55e8acd](https://github.com/solana-foundation/solana-developer-platform/commit/55e8acd9df9cbd0802e66715b17a3d1a3b9d21d7))

## [0.44.0](https://github.com/solana-foundation/solana-developer-platform/compare/v0.43.1...v0.44.0) (2026-07-22)

### Features

* add additional form fields per asset type ([#828](https://github.com/solana-foundation/solana-developer-platform/pull/828)) ([9051b31](https://github.com/solana-foundation/solana-developer-platform/commit/9051b31d12391eeef90ae0f91995b9bc4885451c))

### Bug Fixes

* **tests:** standardize test runs on TEST_DATABASE_URL ([#852](https://github.com/solana-foundation/solana-developer-platform/pull/852)) ([a7cf826](https://github.com/solana-foundation/solana-developer-platform/commit/a7cf8265329e294e5ebc267d8b4eea6a863ca191))
* **e2e:** assert the signer UI the wallet fixtures dictate ([#856](https://github.com/solana-foundation/solana-developer-platform/pull/856)) ([511345b](https://github.com/solana-foundation/solana-developer-platform/commit/511345ba5f059dc7283c099a87c332382e4cb5ac))
* **api:** surface frozen token accounts as 400 ACCOUNT_FROZEN, not 502 ([#776](https://github.com/solana-foundation/solana-developer-platform/pull/776)) ([50b6f70](https://github.com/solana-foundation/solana-developer-platform/commit/50b6f70202520348e3d83a979a359a20d5dc4fab))
* counterparty data fill in ([#829](https://github.com/solana-foundation/solana-developer-platform/pull/829)) ([99194ae](https://github.com/solana-foundation/solana-developer-platform/commit/99194aeca2d3e60733aa4d99be6e0bec4f3ab27b))
* enable non-prod asset profiles and dark-mode wallet cards ([#847](https://github.com/solana-foundation/solana-developer-platform/pull/847)) ([6863901](https://github.com/solana-foundation/solana-developer-platform/commit/68639017c51d6bebee1d2fc001f98801d2d9ac9b))

### Refactors

* **api:** retire Cloudflare infrastructure ([#842](https://github.com/solana-foundation/solana-developer-platform/pull/842)) ([9f6a2c4](https://github.com/solana-foundation/solana-developer-platform/commit/9f6a2c4ff0d0c98d211932cfda4ff1591ababa70))

### Maintenance

* **deps:** bump @hono/node-server from 2.0.5 to 2.0.10 ([#846](https://github.com/solana-foundation/solana-developer-platform/pull/846)) ([4a3622f](https://github.com/solana-foundation/solana-developer-platform/commit/4a3622f3d40599323383aa2b10bde91873b10db4))
* **deps:** bump @hono/node-server from 2.0.4 to 2.0.5 ([#840](https://github.com/solana-foundation/solana-developer-platform/pull/840)) ([53c5a86](https://github.com/solana-foundation/solana-developer-platform/commit/53c5a86a8dbf99191749c816203f4dd2d77f2b56))

## [0.43.1](https://github.com/solana-foundation/solana-developer-platform/compare/v0.43.0...v0.43.1) (2026-07-21)

### Other Changes

* fix wallet setup footer dark mode ([#838](https://github.com/solana-foundation/solana-developer-platform/pull/838)) ([3f22ee9](https://github.com/solana-foundation/solana-developer-platform/commit/3f22ee9a4dedd8e51e7b060ad61874366056d516))
* fix organization bootstrap failure recovery ([#836](https://github.com/solana-foundation/solana-developer-platform/pull/836)) ([f6f61ee](https://github.com/solana-foundation/solana-developer-platform/commit/f6f61ee940808810100b015ac75019aef141383b))

## [0.43.0](https://github.com/solana-foundation/solana-developer-platform/compare/v0.42.0...v0.43.0) (2026-07-21)

### Features

* **payments:** reconcile Coinbase onramp webhooks and surface order economics ([#826](https://github.com/solana-foundation/solana-developer-platform/pull/826)) ([856a014](https://github.com/solana-foundation/solana-developer-platform/commit/856a014fd8234ac9384b2b6b75223311cd7f5746))
* HOO-681, HOO-680, HOO-683, HOO-679, HOO-682 - Advanced settings editor ([#806](https://github.com/solana-foundation/solana-developer-platform/pull/806)) ([bed4ba2](https://github.com/solana-foundation/solana-developer-platform/commit/bed4ba216b194b205278226ef5c21227364a807c))
* HOO-767 Add credential admin auth boundary ([#808](https://github.com/solana-foundation/solana-developer-platform/pull/808)) ([84106a5](https://github.com/solana-foundation/solana-developer-platform/commit/84106a5e2ff613dd508357b8c05a7939a377234e))
* share provider catalog metadata ([#813](https://github.com/solana-foundation/solana-developer-platform/pull/813)) ([afa8871](https://github.com/solana-foundation/solana-developer-platform/commit/afa8871c421eb07d7010967e46223b1fe3bd5836))
* **payments:** enable MoneyGram on-ramp with self-hosted pinned widget SDK ([#820](https://github.com/solana-foundation/solana-developer-platform/pull/820)) ([0807370](https://github.com/solana-foundation/solana-developer-platform/commit/0807370175b42a1913cf0751c972ab887ada057e))
* **api:** restrict recurring payment tokens to stablecoins and issued tokens ([#811](https://github.com/solana-foundation/solana-developer-platform/pull/811)) ([b509dc5](https://github.com/solana-foundation/solana-developer-platform/commit/b509dc528313f341043ade24aca0b8e0e879c3db))
* **web:** Add complete French UI translation catalogs ([#685](https://github.com/solana-foundation/solana-developer-platform/pull/685)) ([535c05b](https://github.com/solana-foundation/solana-developer-platform/commit/535c05b60e88fb0cd47ef05467aea134274afecf))

### Bug Fixes

* prevent organization provisioning races ([#833](https://github.com/solana-foundation/solana-developer-platform/pull/833)) ([94b960b](https://github.com/solana-foundation/solana-developer-platform/commit/94b960ba66f199fa9673e832c296e6a21ac66aae))
* surfpool test reliability ([#817](https://github.com/solana-foundation/solana-developer-platform/pull/817)) ([faff202](https://github.com/solana-foundation/solana-developer-platform/commit/faff202ae3f40cf60f78af56cba5fd0e3b0cd9ff))

### Maintenance

* add prod Cloud Run deploy workflow for sdp-api ([#825](https://github.com/solana-foundation/solana-developer-platform/pull/825)) ([f2ba580](https://github.com/solana-foundation/solana-developer-platform/commit/f2ba5800e1af42f66e37b3aff81302faf0b06769))

### Other Changes

* fix language picker layout shift ([#832](https://github.com/solana-foundation/solana-developer-platform/pull/832)) ([446887b](https://github.com/solana-foundation/solana-developer-platform/commit/446887b2d767aafa5ffad5ae77cf2a9b40b7d2d9))

## [0.42.0](https://github.com/solana-foundation/solana-developer-platform/compare/v0.41.0...v0.42.0) (2026-07-20)

### Features

* **api:** build Kora-sponsored transactions for payment request QRs ([#774](https://github.com/solana-foundation/solana-developer-platform/pull/774)) ([446c1cf](https://github.com/solana-foundation/solana-developer-platform/commit/446c1cf81a0c062b2add155b2e5ed3ed6d9e7b63))
* dark mode theme ([#702](https://github.com/solana-foundation/solana-developer-platform/pull/702)) ([2024ab2](https://github.com/solana-foundation/solana-developer-platform/commit/2024ab2f4ceaf2d1f7b38579a6bc0cc950ac1e58))
* **web:** redesign Payments home and add transaction ledger ([#801](https://github.com/solana-foundation/solana-developer-platform/pull/801)) ([a99bfc0](https://github.com/solana-foundation/solana-developer-platform/commit/a99bfc0bb282d11baa3270c4cf74d689089aa98b))
* **payments:** remove recurring payments master flag ([#766](https://github.com/solana-foundation/solana-developer-platform/pull/766)) ([6799cb3](https://github.com/solana-foundation/solana-developer-platform/commit/6799cb30f8b6f1240204b1a44da9b26a43dff04f))
* **web:** add approval inbox and decision flow ([#739](https://github.com/solana-foundation/solana-developer-platform/pull/739)) ([ce50e89](https://github.com/solana-foundation/solana-developer-platform/commit/ce50e897793180a855453461315882b9adc3bd19))
* **web:** set externalId from a Reference field in batch send ([#753](https://github.com/solana-foundation/solana-developer-platform/pull/753)) ([f06f200](https://github.com/solana-foundation/solana-developer-platform/commit/f06f2009c0ccb911788ba3f5abb069279eb01c41))
* **web:** add policy controls overview ([#737](https://github.com/solana-foundation/solana-developer-platform/pull/737)) ([2ea1dea](https://github.com/solana-foundation/solana-developer-platform/commit/2ea1deabbf6f8a5f686f097c4b5e174912f84e16))
* improve recurring payments ui ([#749](https://github.com/solana-foundation/solana-developer-platform/pull/749)) ([99d33a3](https://github.com/solana-foundation/solana-developer-platform/commit/99d33a37d2acfdc89d0d90bdd34a89f45b23fe1c))
* use ring instead of shadow+border ([#742](https://github.com/solana-foundation/solana-developer-platform/pull/742)) ([d6361f6](https://github.com/solana-foundation/solana-developer-platform/commit/d6361f6126b10530f91b49a725aa0df8a4a551c5))
* **web:** rebuild wallet policy authoring (PRO-1546) ([#730](https://github.com/solana-foundation/solana-developer-platform/pull/730)) ([f8ea849](https://github.com/solana-foundation/solana-developer-platform/commit/f8ea8490f30f7db8721357e77e7aaed3bfeb531f))
* remove svix as a dependency and recommend ngrok ([#740](https://github.com/solana-foundation/solana-developer-platform/pull/740)) ([4e4ae24](https://github.com/solana-foundation/solana-developer-platform/commit/4e4ae24ac083f29dbd8d707884e3ef8fb5ff295e))
* **policy:** add wallet policy audit explorer ([#732](https://github.com/solana-foundation/solana-developer-platform/pull/732)) ([5078047](https://github.com/solana-foundation/solana-developer-platform/commit/50780476a416904868c4535b25c07b5a9028dcbd))
* **i18n:** automate missing translations in release PRs ([#724](https://github.com/solana-foundation/solana-developer-platform/pull/724)) ([51b8458](https://github.com/solana-foundation/solana-developer-platform/commit/51b845889b85995cbaff6c3042020e24ab691623))
* **web:** add API key wallet and policy authoring ([#731](https://github.com/solana-foundation/solana-developer-platform/pull/731)) ([cff7dfc](https://github.com/solana-foundation/solana-developer-platform/commit/cff7dfcc586df1ac992ac5615b92b963a6dbf1a6))
* **policy:** add paginated policy control inventory ([#729](https://github.com/solana-foundation/solana-developer-platform/pull/729)) ([3dcf3d8](https://github.com/solana-foundation/solana-developer-platform/commit/3dcf3d8b6991c8b00792140071e80ed2bab80369))
* **policy:** add audit and revision detail endpoints ([#720](https://github.com/solana-foundation/solana-developer-platform/pull/720)) ([3d93d5b](https://github.com/solana-foundation/solana-developer-platform/commit/3d93d5b202f431f2b3ddd9bffd5bcf0daafcf5af))
* **api:** add API-key policy authoring endpoints (PRO-1534) ([#722](https://github.com/solana-foundation/solana-developer-platform/pull/722)) ([f944a46](https://github.com/solana-foundation/solana-developer-platform/commit/f944a460b2fd89d950d0571182c00f02b69050e3))
* **policy:** expose complete wallet policy rule schema ([#719](https://github.com/solana-foundation/solana-developer-platform/pull/719)) ([b0ffdbb](https://github.com/solana-foundation/solana-developer-platform/commit/b0ffdbb1d8884be6c553537145e914f3fbaf0a44))
* **sdp-api:** cron job entrypoint + GCP Cloud Run deploy (dev) ([#718](https://github.com/solana-foundation/solana-developer-platform/pull/718)) ([5bb35f9](https://github.com/solana-foundation/solana-developer-platform/commit/5bb35f9be51d375554e8ee5663f1939f639f80f3))

### Bug Fixes

* **web:** follow system theme with next-themes ([#805](https://github.com/solana-foundation/solana-developer-platform/pull/805)) ([9136999](https://github.com/solana-foundation/solana-developer-platform/commit/91369997d77f7e65eb404a31e854c511fc8a9d9b))
* **web:** harmonize counterparty table styling ([#803](https://github.com/solana-foundation/solana-developer-platform/pull/803)) ([0bd322d](https://github.com/solana-foundation/solana-developer-platform/commit/0bd322d11d012609dfc38f6a5ac53bf660e6fe76))
* **web:** stop wallet action menu layout shift ([#796](https://github.com/solana-foundation/solana-developer-platform/pull/796)) ([848fbdf](https://github.com/solana-foundation/solana-developer-platform/commit/848fbdf7ac2ac03f9b647dea44b53607f1231ce8))
* **web:** align wallet creation with shared form layout ([#795](https://github.com/solana-foundation/solana-developer-platform/pull/795)) ([bae123e](https://github.com/solana-foundation/solana-developer-platform/commit/bae123e3d00f86e9497be01c46253b8f854e1d9a))
* **web:** align wallet policy stepper with header actions ([#788](https://github.com/solana-foundation/solana-developer-platform/pull/788)) ([c3c41b5](https://github.com/solana-foundation/solana-developer-platform/commit/c3c41b596fd90c3b7d3c9fc39310e44f93d46f3e))
* **web:** respect reduced motion in skeleton loaders ([#773](https://github.com/solana-foundation/solana-developer-platform/pull/773)) ([750b6ff](https://github.com/solana-foundation/solana-developer-platform/commit/750b6ff65c16a50df8e4eed03e1384151c157974))
* **api:** enforce corridor support matrix in ramp quote path ([#752](https://github.com/solana-foundation/solana-developer-platform/pull/752)) ([83f9d16](https://github.com/solana-foundation/solana-developer-platform/commit/83f9d163500a0d84875c023dc7de3a4003366c07))
* **payments:** honor Idempotency-Key for POST /transfer-batches ([#751](https://github.com/solana-foundation/solana-developer-platform/pull/751)) ([bddeede](https://github.com/solana-foundation/solana-developer-platform/commit/bddeede1e516a9e1ee4754bcf2a08105557fcbf2))
* **deps:** bump hono and @sentry, pin fast-uri/postcss to clear runtime advisories ([#754](https://github.com/solana-foundation/solana-developer-platform/pull/754)) ([84e4432](https://github.com/solana-foundation/solana-developer-platform/commit/84e4432f350f4184e97e117c394427d84be38cde))
* **config:** propagate recurring collection settings ([#712](https://github.com/solana-foundation/solana-developer-platform/pull/712)) ([d6f8910](https://github.com/solana-foundation/solana-developer-platform/commit/d6f89106b4a9dadce081045a072a14ecc5b88102))
* keep Cloudflare deploy production-only ([#736](https://github.com/solana-foundation/solana-developer-platform/pull/736)) ([38aadf4](https://github.com/solana-foundation/solana-developer-platform/commit/38aadf4733680cfba2687a1894f11d8e4e92cb38))
* business counterparties can't complete a Lightspark off-ramp ([#706](https://github.com/solana-foundation/solana-developer-platform/pull/706)) ([92ca38d](https://github.com/solana-foundation/solana-developer-platform/commit/92ca38d564967a2280a0ef9c676dee6781697e9d))

### Performance Improvements

* **web:** add immediate dashboard navigation feedback ([#771](https://github.com/solana-foundation/solana-developer-platform/pull/771)) ([4788698](https://github.com/solana-foundation/solana-developer-platform/commit/478869821d4465078bac33c6f5e14cfbbe7f5e6e))
* **web:** defer wallet activity below viewport ([#793](https://github.com/solana-foundation/solana-developer-platform/pull/793)) ([8a00bdd](https://github.com/solana-foundation/solana-developer-platform/commit/8a00bdd61700916d2a45e38be56b2dee48c8888d))
* **web:** add home and payments route loading states ([#772](https://github.com/solana-foundation/solana-developer-platform/pull/772)) ([6885173](https://github.com/solana-foundation/solana-developer-platform/commit/688517324bd4c1dde49809d9e5586f7e3cda64e9))
* **web:** eliminate wallet route loading gaps ([#767](https://github.com/solana-foundation/solana-developer-platform/pull/767)) ([1cf677e](https://github.com/solana-foundation/solana-developer-platform/commit/1cf677e00513d3d250bb36dc42e7071a9f2a2fc3))
* **web:** reduce dashboard round trips ([#763](https://github.com/solana-foundation/solana-developer-platform/pull/763)) ([21d054c](https://github.com/solana-foundation/solana-developer-platform/commit/21d054c01976b5b827f6e88d22806469e86a8b1a))
* **web:** add operations route loading states ([#768](https://github.com/solana-foundation/solana-developer-platform/pull/768)) ([d180617](https://github.com/solana-foundation/solana-developer-platform/commit/d180617652c614f3d66040f08c32309b7662c248))
* **wallets:** skip balance RPC for metadata reads ([#770](https://github.com/solana-foundation/solana-developer-platform/pull/770)) ([537823a](https://github.com/solana-foundation/solana-developer-platform/commit/537823a94d2a022fa9f3ddff957dcae3bc36a366))
* **api:** reduce Node/GCP request latency ([#762](https://github.com/solana-foundation/solana-developer-platform/pull/762)) ([9fcba76](https://github.com/solana-foundation/solana-developer-platform/commit/9fcba76df84e149c394b62fd1c02cb2a88140727))

### Maintenance

* **security:** add Hacktron review rules ([#726](https://github.com/solana-foundation/solana-developer-platform/pull/726)) ([4904e45](https://github.com/solana-foundation/solana-developer-platform/commit/4904e45f4917d6f9385e962c20eb10ee3ad578da))
* improve local onboarding experience ([#713](https://github.com/solana-foundation/solana-developer-platform/pull/713)) ([cd8f040](https://github.com/solana-foundation/solana-developer-platform/commit/cd8f040765a12d9d97add826fff5ee8839d3502a))

## [0.41.0](https://github.com/solana-foundation/solana-developer-platform/compare/v0.40.0...v0.41.0) (2026-07-15)

### Features

* **HOO-716:** idempotency for POST /transfers ([#710](https://github.com/solana-foundation/solana-developer-platform/pull/710)) ([2ee52e6](https://github.com/solana-foundation/solana-developer-platform/commit/2ee52e6c636742bce898354f58df9a915db7899a))
* add counterparty requirements endpoint to public openapi spec ([#698](https://github.com/solana-foundation/solana-developer-platform/pull/698)) ([8e8df25](https://github.com/solana-foundation/solana-developer-platform/commit/8e8df2543521d2a79e4235fbb3854b862d53099d))
* return idempotency key and server-timing for the response ([#681](https://github.com/solana-foundation/solana-developer-platform/pull/681)) ([bde2698](https://github.com/solana-foundation/solana-developer-platform/commit/bde26980fac1d41f96aa32417ac8e5bfed9ffa40))

### Bug Fixes

* enforce counterparty addresss in playground ([#705](https://github.com/solana-foundation/solana-developer-platform/pull/705)) ([add795c](https://github.com/solana-foundation/solana-developer-platform/commit/add795c076ce36ab1aee4307fbbdf8b16de99051))
* minor ui fixes ([#669](https://github.com/solana-foundation/solana-developer-platform/pull/669)) ([d529bb4](https://github.com/solana-foundation/solana-developer-platform/commit/d529bb44ddeb234b7f3cf36c999c45f64248f8d5))
* api playground crashing due to i18n mis-interpolation ([#699](https://github.com/solana-foundation/solana-developer-platform/pull/699)) ([e26302f](https://github.com/solana-foundation/solana-developer-platform/commit/e26302ff54bfd031a1c337be543afdf4daac21e0))

### Refactors

* isolate custody wallet provisioning ([#690](https://github.com/solana-foundation/solana-developer-platform/pull/690)) ([1b1facf](https://github.com/solana-foundation/solana-developer-platform/commit/1b1facfe0ffb291626a10cf7438ad350a17681be))
* **sdp-api:** remove remaining workspace compatibility shims ([#688](https://github.com/solana-foundation/solana-developer-platform/pull/688)) ([9db1a7a](https://github.com/solana-foundation/solana-developer-platform/commit/9db1a7a4214be7b2f7a35ffa5abd3954bc6e3f06))
* harden workspace module isolation ([#692](https://github.com/solana-foundation/solana-developer-platform/pull/692)) ([31e0dc6](https://github.com/solana-foundation/solana-developer-platform/commit/31e0dc6b9ea07ff23facc8ad7ad7ab9d1d4b2a9a))
* **payments:** extract recurring payment lifecycle ([#689](https://github.com/solana-foundation/solana-developer-platform/pull/689)) ([369ff70](https://github.com/solana-foundation/solana-developer-platform/commit/369ff70b66b90a2a3790527703d391c738a27155))

### Maintenance

* remove create project endpoint ([#696](https://github.com/solana-foundation/solana-developer-platform/pull/696)) ([31a2eb1](https://github.com/solana-foundation/solana-developer-platform/commit/31a2eb1bbc51c45687710a3378d4b0a726ee66a3))

## [0.40.0](https://github.com/solana-foundation/solana-developer-platform/compare/v0.39.0...v0.40.0) (2026-07-11)

### Features

* **web:** add UI i18n foundation ([#670](https://github.com/solana-foundation/solana-developer-platform/pull/670)) ([2f770de](https://github.com/solana-foundation/solana-developer-platform/commit/2f770de88bf5cc8d57c54eea0a537b69c2701137))
* currency picker for asset profiles and fixes ([#664](https://github.com/solana-foundation/solana-developer-platform/pull/664)) ([e887870](https://github.com/solana-foundation/solana-developer-platform/commit/e887870566b295df9d1a141c49ba662a2461fa6b))

### Bug Fixes

* **API:** Detect Postgres unique violations by SQLSTATE, not SQLite text ([#587](https://github.com/solana-foundation/solana-developer-platform/pull/587)) ([43baaa5](https://github.com/solana-foundation/solana-developer-platform/commit/43baaa57f70f8f575cf145f2edb0ea61d2b787ae))
* **payments:** accept well-known token symbols anywhere a token mint is accepted ([#660](https://github.com/solana-foundation/solana-developer-platform/pull/660)) ([1819486](https://github.com/solana-foundation/solana-developer-platform/commit/18194865f5e5eecbd1ab863adff8ca49de4cab3f))
* asset profiles management ui tweaks and improvements ([#655](https://github.com/solana-foundation/solana-developer-platform/pull/655)) ([196b1f3](https://github.com/solana-foundation/solana-developer-platform/commit/196b1f3742be1b4cdb20438c6687fcd3f2b9930c))
* eliminate unsafe float arithmetic on money amounts ([#654](https://github.com/solana-foundation/solana-developer-platform/pull/654)) ([0ecfeae](https://github.com/solana-foundation/solana-developer-platform/commit/0ecfeae61f90da205919667010b4dd08d1b4bee4))
* **sdp-api:** document wallet inputs as the provider walletId ([#647](https://github.com/solana-foundation/solana-developer-platform/pull/647)) ([6e6bcd9](https://github.com/solana-foundation/solana-developer-platform/commit/6e6bcd9a3193522399e306456787559f0d4b0933))
* Asset profiles UI fixes and updates ([#646](https://github.com/solana-foundation/solana-developer-platform/pull/646)) ([954afc7](https://github.com/solana-foundation/solana-developer-platform/commit/954afc73a0e5b02f146a2c7cbcb55baa4aab7b89))
* **rpc:** add per-request transport deadline to RPC client ([#637](https://github.com/solana-foundation/solana-developer-platform/pull/637)) ([81e2ef2](https://github.com/solana-foundation/solana-developer-platform/commit/81e2ef2680bbe8a6f5971d940208caaf78ea2afa))

### Refactors

* move issuance internals into workspace package ([#653](https://github.com/solana-foundation/solana-developer-platform/pull/653)) ([88fd198](https://github.com/solana-foundation/solana-developer-platform/commit/88fd19849917207c426594eb4aaea975cfadd95b))
* **sdp-api:** drop @sdp/solana re-export shims ([#642](https://github.com/solana-foundation/solana-developer-platform/pull/642)) ([f96ba8f](https://github.com/solana-foundation/solana-developer-platform/commit/f96ba8f47bcd7d47dcf9f7ad14a3a47af7a124f9))

### Other Changes

* Add Validation Cloud as an RPC provider ([#657](https://github.com/solana-foundation/solana-developer-platform/pull/657)) ([5bc65d9](https://github.com/solana-foundation/solana-developer-platform/commit/5bc65d996599314fd3b274bca365fc9c9ee920b1))

## [0.39.0](https://github.com/solana-foundation/solana-developer-platform/compare/v0.38.0...v0.39.0) (2026-07-09)

### Features

* HOO-671 Asset profile creation UI ([#579](https://github.com/solana-foundation/solana-developer-platform/pull/579)) ([644a330](https://github.com/solana-foundation/solana-developer-platform/commit/644a330dbef0b04f20f5600bdcbf5a5d615f22d5))

### Bug Fixes

* sync Stripe and Mural secrets to the deployed worker ([#643](https://github.com/solana-foundation/solana-developer-platform/pull/643)) ([9fa00fa](https://github.com/solana-foundation/solana-developer-platform/commit/9fa00fa2d28947908782ae641b65b8ef78d282d9))

### Refactors

* **sdp-api:** drop @sdp/rpc re-export shims ([#628](https://github.com/solana-foundation/solana-developer-platform/pull/628)) ([735ff69](https://github.com/solana-foundation/solana-developer-platform/commit/735ff694adda7a1f8929ff6483ed344b45b253f0))

## [0.38.0](https://github.com/solana-foundation/solana-developer-platform/compare/v0.37.0...v0.38.0) (2026-07-09)

### Features

* ramp support matrix revamp (ISO, countries, entities, limits) + provider availability UX ([#635](https://github.com/solana-foundation/solana-developer-platform/pull/635)) ([b137822](https://github.com/solana-foundation/solana-developer-platform/commit/b1378228e7e122ea3080f4bc91e6dc437e4bcea7))
* add Stripe ramp provider (on-ramp session widget) ([#631](https://github.com/solana-foundation/solana-developer-platform/pull/631)) ([b6402b7](https://github.com/solana-foundation/solana-developer-platform/commit/b6402b77a48519ec148d5b8b0c214d1143ac01db))
* add Mural Pay ramp provider (on-ramp) ([#632](https://github.com/solana-foundation/solana-developer-platform/pull/632)) ([fa14064](https://github.com/solana-foundation/solana-developer-platform/commit/fa14064349dc5186eac6e9be426962d9109e0933))

### Bug Fixes

* **observability:** gate Sentry to deployed environments and type invalid-address errors ([#630](https://github.com/solana-foundation/solana-developer-platform/pull/630)) ([93997d5](https://github.com/solana-foundation/solana-developer-platform/commit/93997d5db7b9caecd9ca57ceb3b1b2166a258740))

### Refactors

* move payments internals into workspace package ([#625](https://github.com/solana-foundation/solana-developer-platform/pull/625)) ([9726755](https://github.com/solana-foundation/solana-developer-platform/commit/972675501b166e4e74290445b0e9f24d14ce3b9c))
* move solana internals into workspace package ([#623](https://github.com/solana-foundation/solana-developer-platform/pull/623)) ([6a2ae8a](https://github.com/solana-foundation/solana-developer-platform/commit/6a2ae8a8d0d6995c03ce2def83f28afd79364df3))
* move custody internals into workspace package ([#624](https://github.com/solana-foundation/solana-developer-platform/pull/624)) ([a02d305](https://github.com/solana-foundation/solana-developer-platform/commit/a02d30599ca66ef5cc5f9674b7e9798b3da9f55f))

## [0.37.0](https://github.com/solana-foundation/solana-developer-platform/compare/v0.36.0...v0.37.0) (2026-07-08)

### Features

* **policy:** expose wallet evaluation audit visibility ([#604](https://github.com/solana-foundation/solana-developer-platform/pull/604)) ([5f4e854](https://github.com/solana-foundation/solana-developer-platform/commit/5f4e854df89aa1a61571bf2cc2e72a251b8e5751))
* **api:** add credential redaction baseline ([#606](https://github.com/solana-foundation/solana-developer-platform/pull/606)) ([6ba59eb](https://github.com/solana-foundation/solana-developer-platform/commit/6ba59eb7a469f08e62bc1a3be7d3720798e93dbb))
* **sdp-api:** HOO-661 Asset profiles API ([#465](https://github.com/solana-foundation/solana-developer-platform/pull/465)) ([cd88973](https://github.com/solana-foundation/solana-developer-platform/commit/cd88973a9913b4590b61dc4f634f6fc8d0e5c945))
* **sdp-api:** HOO-777 Add IBM Haven as a new custody/signing provider ([#585](https://github.com/solana-foundation/solana-developer-platform/pull/585)) ([50e7463](https://github.com/solana-foundation/solana-developer-platform/commit/50e7463d13f9fa438719a8ee9de01c0288471880))
* **api:** add credential secret store boundary (HOO-765) ([#580](https://github.com/solana-foundation/solana-developer-platform/pull/580)) ([2b2feb2](https://github.com/solana-foundation/solana-developer-platform/commit/2b2feb23362d73670a476a461221a2860dac16b7))

### Bug Fixes

* **sdp-api:** create the test database before running pnpm test ([#488](https://github.com/solana-foundation/solana-developer-platform/pull/488)) ([bcb43f1](https://github.com/solana-foundation/solana-developer-platform/commit/bcb43f1449bc4947a78a8279b7428e106c268572))

### Refactors

* move RPC internals into workspace package ([#608](https://github.com/solana-foundation/solana-developer-platform/pull/608)) ([c67284e](https://github.com/solana-foundation/solana-developer-platform/commit/c67284ea632357ad83c9a868e833dccc9cf50c4c))
* **sdp-api:** standardize ramp providers into per-capability directories with webhook processors (PRO-1532) ([#618](https://github.com/solana-foundation/solana-developer-platform/pull/618)) ([f2740cc](https://github.com/solana-foundation/solana-developer-platform/commit/f2740ccf25caa2e1e9d096dc2ee932b418ea7d90))

## [0.36.0](https://github.com/solana-foundation/solana-developer-platform/compare/v0.35.1...v0.36.0) (2026-07-07)

### Features

* **issuance:** allow manual fee payer when deploying through Kora fails ([#601](https://github.com/solana-foundation/solana-developer-platform/pull/601)) ([6fbb352](https://github.com/solana-foundation/solana-developer-platform/commit/6fbb3529b3150afa5f98c6489f9d9b73986a32c7))

### Maintenance

* create release branch when ref update returns 422 ([#602](https://github.com/solana-foundation/solana-developer-platform/pull/602)) ([fffefed](https://github.com/solana-foundation/solana-developer-platform/commit/fffefede848272094889737e4df021f060b6634e))

## [0.35.1](https://github.com/solana-foundation/solana-developer-platform/compare/v0.35.0...v0.35.1) (2026-07-07)

### Maintenance

* create signed release PR commits ([ef053df](https://github.com/solana-foundation/solana-developer-platform/commit/ef053df212faec0d3236597dc3467b7264c21f34))
* release through auto-merged PR ([#597](https://github.com/solana-foundation/solana-developer-platform/pull/597)) ([0b20f73](https://github.com/solana-foundation/solana-developer-platform/commit/0b20f737c9e36f5b1395492ec8d8f7cb5ee936b5))
* sign generated release commits ([#596](https://github.com/solana-foundation/solana-developer-platform/pull/596)) ([c3d43ff](https://github.com/solana-foundation/solana-developer-platform/commit/c3d43ff628aedcd876ab8e7fa2551d872fbe36fd))
* release directly after production approval ([#586](https://github.com/solana-foundation/solana-developer-platform/pull/586)) ([15ac676](https://github.com/solana-foundation/solana-developer-platform/commit/15ac6765f7a36de9f400611ff4b119a4f56ee1f9))
* harden npm and GitHub Actions supply chain ([#593](https://github.com/solana-foundation/solana-developer-platform/pull/593)) ([eb59d6b](https://github.com/solana-foundation/solana-developer-platform/commit/eb59d6b95989b7a3e5e9b14a7b6ee26fc519667d))

## [0.35.0](https://github.com/solana-foundation/solana-developer-platform/compare/v0.34.0...v0.35.0) (2026-07-06)

### Features

* **ramps:** Coinbase Onramp (headless v2 Apple Pay) provider ([#590](https://github.com/solana-foundation/solana-developer-platform/pull/590)) ([ec7119c](https://github.com/solana-foundation/solana-developer-platform/commit/ec7119c322cea87dc63afd30fd54e3c85d700c78))
* finalize recurring payment detail UI ([#582](https://github.com/solana-foundation/solana-developer-platform/pull/582)) ([d69b4de](https://github.com/solana-foundation/solana-developer-platform/commit/d69b4deb5a52a4999db190b9c2a2ef8328080d29))

### Bug Fixes

* **payments:** remove POST /transfers/prepare — prepared transfers polluted history as failed ([#589](https://github.com/solana-foundation/solana-developer-platform/pull/589)) ([7709468](https://github.com/solana-foundation/solana-developer-platform/commit/770946822c4cccdd3a3b4ceb12e21b7fb7e94aff))
* **observability:** set PagerDuty payload.source so kora alerts deliver ([#576](https://github.com/solana-foundation/solana-developer-platform/pull/576)) ([eec6c84](https://github.com/solana-foundation/solana-developer-platform/commit/eec6c84aeaaec774dc0ae5b23b173fb4ca87ad07))

### Documentation

* drop stale infra/kora entry from repository map ([#583](https://github.com/solana-foundation/solana-developer-platform/pull/583)) ([85414fe](https://github.com/solana-foundation/solana-developer-platform/commit/85414fe17aeeebedff117f7c84ab3ecf7eb809b3))

### Refactors

* **sdp-web:** extract shared proxyToSdpApi helper for dashboard API routes ([#592](https://github.com/solana-foundation/solana-developer-platform/pull/592)) ([ebb689a](https://github.com/solana-foundation/solana-developer-platform/commit/ebb689a8d85f57eba62fa9f19166dce65f9f2ac4))

### Maintenance

* **kora:** remove grafana observability (consolidated into sdp-infra) ([#591](https://github.com/solana-foundation/solana-developer-platform/pull/591)) ([a9fba02](https://github.com/solana-foundation/solana-developer-platform/commit/a9fba02db9743135682693aa1e617451d01da06f))

### Other Changes

* first time login fix ([#594](https://github.com/solana-foundation/solana-developer-platform/pull/594)) ([fac503c](https://github.com/solana-foundation/solana-developer-platform/commit/fac503cd1ac477c9d2b0befb32fddc5f4cb5bffe))

## [0.34.0](https://github.com/solana-foundation/solana-developer-platform/compare/v0.33.0...v0.34.0) (2026-07-02)

### Features

* wire recurring payment cron automation ([#570](https://github.com/solana-foundation/solana-developer-platform/pull/570)) ([0a24f9c](https://github.com/solana-foundation/solana-developer-platform/commit/0a24f9c7046bf0bc5c632b7ab176f42f124f7d0a))
* **payments:** offer all well-known tokens when creating payment requests ([#575](https://github.com/solana-foundation/solana-developer-platform/pull/575)) ([ecce5fe](https://github.com/solana-foundation/solana-developer-platform/commit/ecce5fefa32e9226e303549c165b841859f52eee))
* **payments:** label custom tokens in batch asset picker ([#553](https://github.com/solana-foundation/solana-developer-platform/pull/553)) ([30a2c99](https://github.com/solana-foundation/solana-developer-platform/commit/30a2c99d06a9b19ef513f8be12344ed04ff8f6e7))
* **sdp-api:** add provider credential custody tables (HOO-764) ([#555](https://github.com/solana-foundation/solana-developer-platform/pull/555)) ([d703d44](https://github.com/solana-foundation/solana-developer-platform/commit/d703d4465b1f39f49c2a3cf8b8c5c9c62b7895bb))
* **api:** add approval request persistence ([#554](https://github.com/solana-foundation/solana-developer-platform/pull/554)) ([31e9772](https://github.com/solana-foundation/solana-developer-platform/commit/31e9772b1661b6f73334a5165389a1eb5ec6d536))
* **sdp-api:** forward user_id to Kora on sign calls (PRO-1348) ([#548](https://github.com/solana-foundation/solana-developer-platform/pull/548)) ([2850fce](https://github.com/solana-foundation/solana-developer-platform/commit/2850fce4657d4d7f62967c8305e2d103d207adef))
* add recurring payment lifecycle controls ([#550](https://github.com/solana-foundation/solana-developer-platform/pull/550)) ([1639344](https://github.com/solana-foundation/solana-developer-platform/commit/16393444c1d6769a869b2a97fb2638d1b0b3e34d))
* **payments:** batch send — recipient selection, bulk import, custom mints ([#549](https://github.com/solana-foundation/solana-developer-platform/pull/549)) ([e4b67b7](https://github.com/solana-foundation/solana-developer-platform/commit/e4b67b7d75a6144bcbfa2eb4f876323054bd8c4f))
* **api-keys:** surface wallet policy access ([#545](https://github.com/solana-foundation/solana-developer-platform/pull/545)) ([ec3fc29](https://github.com/solana-foundation/solana-developer-platform/commit/ec3fc292e6cb8ae07b1f05b48a1c80a5fc3b319f))
* **payments:** add recurring payment create flow ([#537](https://github.com/solana-foundation/solana-developer-platform/pull/537)) ([e6fb3f9](https://github.com/solana-foundation/solana-developer-platform/commit/e6fb3f973a21e24cd6d74948ff6fbba2d9a6723e))
* **payments:** add recurring payment update API ([#547](https://github.com/solana-foundation/solana-developer-platform/pull/547)) ([b78599c](https://github.com/solana-foundation/solana-developer-platform/commit/b78599cf343f86c9c2baced635b58b13ef28ec59))
* **sdp-api:** batch payment transfers to multiple counterparties ([#535](https://github.com/solana-foundation/solana-developer-platform/pull/535)) ([c3906dd](https://github.com/solana-foundation/solana-developer-platform/commit/c3906dd95f3ddd10a3e7876e897ffc4e5ee2bc0f))
* **sdp-api:** scaffold batch payments table ([#534](https://github.com/solana-foundation/solana-developer-platform/pull/534)) ([a5cf049](https://github.com/solana-foundation/solana-developer-platform/commit/a5cf0492cce05faef8482acb73689947aff1db7f))
* **web:** add recurring payment list and detail views ([#527](https://github.com/solana-foundation/solana-developer-platform/pull/527)) ([ffa7591](https://github.com/solana-foundation/solana-developer-platform/commit/ffa7591bf3a05b0b41465362207dfb00c809e3fb))
* **web:** add wallet policy operation rules flow ([#529](https://github.com/solana-foundation/solana-developer-platform/pull/529)) ([33ae6ec](https://github.com/solana-foundation/solana-developer-platform/commit/33ae6ec41c0ac3466f0ee3c23bdb58e7435df748))
* **web:** add recurring payments dashboard plumbing ([#525](https://github.com/solana-foundation/solana-developer-platform/pull/525)) ([4c0e2c7](https://github.com/solana-foundation/solana-developer-platform/commit/4c0e2c7f7ea57e3e92fcf7c93e577caf0ca7eae0))
* **api:** harden recurring activation recovery ([#523](https://github.com/solana-foundation/solana-developer-platform/pull/523)) ([1bef4c3](https://github.com/solana-foundation/solana-developer-platform/commit/1bef4c3378517ef5dbd106947b899efb52458d71))
* **api:** add recurring payment lifecycle routes ([#517](https://github.com/solana-foundation/solana-developer-platform/pull/517)) ([1241c12](https://github.com/solana-foundation/solana-developer-platform/commit/1241c1239a147c2ecf97ed426b0642e0c1a56b18))
* **sdp-web:** HOO-475 - Show signer authority indicator for Freeze and Pause actions ([#450](https://github.com/solana-foundation/solana-developer-platform/pull/450)) ([d8a9660](https://github.com/solana-foundation/solana-developer-platform/commit/d8a9660f4b12660baa8773f1c990c97869f0f826))
* HOO-709 Suport native fee payments using NativeAdapter ([#521](https://github.com/solana-foundation/solana-developer-platform/pull/521)) ([adf47b0](https://github.com/solana-foundation/solana-developer-platform/commit/adf47b097c8c1c5bfc1493c2310676a58f66fc03))
* **payments:** settle payment requests on read via Solana Pay reference ([#522](https://github.com/solana-foundation/solana-developer-platform/pull/522)) ([849014f](https://github.com/solana-foundation/solana-developer-platform/commit/849014f841b6512fbbd35a1ee4b0475f90e2bb34))
* **payments:** request-for-payment links with Solana Pay QR + reconciliation ([#515](https://github.com/solana-foundation/solana-developer-platform/pull/515)) ([9d322e0](https://github.com/solana-foundation/solana-developer-platform/commit/9d322e0503f723615b3196995b6069971a8c8275))

### Bug Fixes

* **payments:** revalidate wallet and counterparty caches in action wizards ([#577](https://github.com/solana-foundation/solana-developer-platform/pull/577)) ([da4c559](https://github.com/solana-foundation/solana-developer-platform/commit/da4c559732cc6852be3de2146a224c77dfebec76))
* **api:** surface typed errors from on-chain submit and confirm paths ([#574](https://github.com/solana-foundation/solana-developer-platform/pull/574)) ([a66aa6a](https://github.com/solana-foundation/solana-developer-platform/commit/a66aa6a67ea4dd05c8d5e7c8164402211b557bee))
* **ramps:** normalize subdivision codes to BVNK's 2-char stateCode ([#573](https://github.com/solana-foundation/solana-developer-platform/pull/573)) ([f9c0a46](https://github.com/solana-foundation/solana-developer-platform/commit/f9c0a469c47bb6313d6afa295dc8738957d82ee9))
* **counterparties:** validate dateOfBirth and phone identity fields ([#572](https://github.com/solana-foundation/solana-developer-platform/pull/572)) ([42cc472](https://github.com/solana-foundation/solana-developer-platform/commit/42cc4729cc7549ca531f92b2b87fc5a4ed3f707a))
* **payments:** include SOL in Pay and Batch asset options ([#571](https://github.com/solana-foundation/solana-developer-platform/pull/571)) ([1ce8a34](https://github.com/solana-foundation/solana-developer-platform/commit/1ce8a34d32da640ccb495699305fad7a8e276f6b))
* **sdp-web:** compliance screening with provider risk cards ([#533](https://github.com/solana-foundation/solana-developer-platform/pull/533)) ([8d292ff](https://github.com/solana-foundation/solana-developer-platform/commit/8d292ff822fe524acde463a77412e51fc5657c37))
* standardize UI for lightspark/bvnk and ramps in general ([#531](https://github.com/solana-foundation/solana-developer-platform/pull/531)) ([8b45e0e](https://github.com/solana-foundation/solana-developer-platform/commit/8b45e0ed6262b5b35265c2a9dd4a0fe434d33350))
* bvnk onramp/offramp bugs and add tests ([#530](https://github.com/solana-foundation/solana-developer-platform/pull/530)) ([df7570e](https://github.com/solana-foundation/solana-developer-platform/commit/df7570e5ce7fe2a93631b4c292b0949296dfc025))

### Documentation

* align Node/pnpm prerequisites with package.json engines ([#556](https://github.com/solana-foundation/solana-developer-platform/pull/556)) ([9692927](https://github.com/solana-foundation/solana-developer-platform/commit/969292751257edfd2809f38ba5e7e5ece5e9976f))

### Refactors

* **payments:** remove ramp execute endpoints, keep quote-only flow ([#552](https://github.com/solana-foundation/solana-developer-platform/pull/552)) ([3e7def4](https://github.com/solana-foundation/solana-developer-platform/commit/3e7def41d1049cd7c8604dc2dfc8dda72a7793c5))
* centralize well-known token mints into a shared registry ([#520](https://github.com/solana-foundation/solana-developer-platform/pull/520)) ([fedd439](https://github.com/solana-foundation/solana-developer-platform/commit/fedd4393e78de8b52d600936418806b2192d98b3))

### Maintenance

* **surfpool:** finish browser e2e runbook ([#546](https://github.com/solana-foundation/solana-developer-platform/pull/546)) ([fd22072](https://github.com/solana-foundation/solana-developer-platform/commit/fd22072fb82ec90849dbf2b77d38e50b1e5ea0b0))
* **payments:** fix hardcoded expiry in payment-request repo test ([#551](https://github.com/solana-foundation/solana-developer-platform/pull/551)) ([f1efcf1](https://github.com/solana-foundation/solana-developer-platform/commit/f1efcf14e43a5393204757c965f69fe7590db29f))
* **kora:** drop kora terraform + infra + observability (moved to sdp-infra) ([#532](https://github.com/solana-foundation/solana-developer-platform/pull/532)) ([749ab48](https://github.com/solana-foundation/solana-developer-platform/commit/749ab480315c9a156724c4ce4d1e616abf180f28))
* run access custody shard on surfpool local ([#528](https://github.com/solana-foundation/solana-developer-platform/pull/528)) ([8952fc8](https://github.com/solana-foundation/solana-developer-platform/commit/8952fc88b43f6881136909725a94fbc31fbcd107))
* slim Kora live smoke suite ([#524](https://github.com/solana-foundation/solana-developer-platform/pull/524)) ([78241ac](https://github.com/solana-foundation/solana-developer-platform/commit/78241acbed1f1551a8db5f475bc8abfde1531fff))
* run API integration shards on Surfpool ([#518](https://github.com/solana-foundation/solana-developer-platform/pull/518)) ([e08817f](https://github.com/solana-foundation/solana-developer-platform/commit/e08817f7d4ee0f481b70fd5a39e87f1cb72f91f9))
* select surfpool remote rpc ([#516](https://github.com/solana-foundation/solana-developer-platform/pull/516)) ([8853909](https://github.com/solana-foundation/solana-developer-platform/commit/8853909f14194281d9629a3a92476efcaa31b186))

## [0.33.0](https://github.com/solana-foundation/solana-developer-platform/compare/v0.32.0...v0.33.0) (2026-06-24)

### Features

* **api:** add recurring payment manual collection ([#511](https://github.com/solana-foundation/solana-developer-platform/pull/511)) ([b24ce27](https://github.com/solana-foundation/solana-developer-platform/commit/b24ce2726b45bc883df65da3b1bf0faf9612ae9d))
* add wallet policy starting profile flow ([#510](https://github.com/solana-foundation/solana-developer-platform/pull/510)) ([3ec18b9](https://github.com/solana-foundation/solana-developer-platform/commit/3ec18b913365332e0b21ab28590010c30417ca09))
* **payments:** add Solana Pay primitives + signed request links ([#513](https://github.com/solana-foundation/solana-developer-platform/pull/513)) ([c0ef0ac](https://github.com/solana-foundation/solana-developer-platform/commit/c0ef0ac0f011d24dd47cbc5c4c3f889309080566))
* **api:** enforce wallet and API key policies server-side ([#485](https://github.com/solana-foundation/solana-developer-platform/pull/485)) ([d92d027](https://github.com/solana-foundation/solana-developer-platform/commit/d92d027f0186c72c3d50103afbca171b1c349d36))
* **payments:** recover recurring activation ([#499](https://github.com/solana-foundation/solana-developer-platform/pull/499)) ([0b2fd0b](https://github.com/solana-foundation/solana-developer-platform/commit/0b2fd0b10a0e798da92e2b2aa4b6fe3822204115))

### Bug Fixes

* **kora:** deploy.sh uses crane, not gcrane ([#508](https://github.com/solana-foundation/solana-developer-platform/pull/508)) ([9c65c88](https://github.com/solana-foundation/solana-developer-platform/commit/9c65c88158e57cfca538be51d400e30b8a63df4b))

### Maintenance

* add Kora Surfpool local harness ([#512](https://github.com/solana-foundation/solana-developer-platform/pull/512)) ([9df3ac6](https://github.com/solana-foundation/solana-developer-platform/commit/9df3ac6aa955ac58422acf3b3c342d4784992464))
* **kora:** pin deploy image to 8249b4a (glibc fix) ([#514](https://github.com/solana-foundation/solana-developer-platform/pull/514)) ([4b4784b](https://github.com/solana-foundation/solana-developer-platform/commit/4b4784b2bc31a57ae7e0f09bfa897ffc99b7f530))
* **kora:** STARTED + SUCCESS/FAILED Slack messages on deploy ([#509](https://github.com/solana-foundation/solana-developer-platform/pull/509)) ([b535501](https://github.com/solana-foundation/solana-developer-platform/commit/b535501bc246d96cdfa74aedc21b57f8430d8211))
* **payments:** remove v1 and paymentsV2 feature flag ([#504](https://github.com/solana-foundation/solana-developer-platform/pull/504)) ([089519a](https://github.com/solana-foundation/solana-developer-platform/commit/089519a689045b5bf73292f3a58d0cfab4e1a540))
* **kora:** pin deploy to immutable :<git-sha> (not :edge) ([#501](https://github.com/solana-foundation/solana-developer-platform/pull/501)) ([ec193ee](https://github.com/solana-foundation/solana-developer-platform/commit/ec193ee2f30a2c04b4bd52a3fb872a4fa1ef1360))

## [0.32.0](https://github.com/solana-foundation/solana-developer-platform/compare/v0.31.0...v0.32.0) (2026-06-23)

### Features

* **payments:** payment_requests data layer ([#505](https://github.com/solana-foundation/solana-developer-platform/pull/505)) ([7215859](https://github.com/solana-foundation/solana-developer-platform/commit/72158598b4e2bd241aae9f792efb423060544e70))
* **observability:** SDP Cloud Run observability + Kora SDP cutover ([#496](https://github.com/solana-foundation/solana-developer-platform/pull/496)) ([7106be6](https://github.com/solana-foundation/solana-developer-platform/commit/7106be68db2542ad6cd6c646ade5a4387057a9e6))
* **kora:** deploy by pinned tag, config from Secret Manager, auto devnet→mainnet ([#498](https://github.com/solana-foundation/solana-developer-platform/pull/498)) ([aaa804a](https://github.com/solana-foundation/solana-developer-platform/commit/aaa804aa752a48e6fe05a58bbbb0e5b452244bb2))
* add moneygram credentials to cf workers ([#497](https://github.com/solana-foundation/solana-developer-platform/pull/497)) ([9c7d7c6](https://github.com/solana-foundation/solana-developer-platform/commit/9c7d7c66d693e23cd4dec9e42777ac99bee665d3))
* turn on paymentsv2 feature flag ([#492](https://github.com/solana-foundation/solana-developer-platform/pull/492)) ([aa05a93](https://github.com/solana-foundation/solana-developer-platform/commit/aa05a9360b3f7d8c510356a47d4bbb6bd2fdfc98))
* **payments:** add MoneyGram as an SDP ramps provider ([#491](https://github.com/solana-foundation/solana-developer-platform/pull/491)) ([38ed43c](https://github.com/solana-foundation/solana-developer-platform/commit/38ed43c88672e6ff658ee049b8318ab56c706701))
* set max transferrable amount in the UI for clarity ([#490](https://github.com/solana-foundation/solana-developer-platform/pull/490)) ([4c10f53](https://github.com/solana-foundation/solana-developer-platform/commit/4c10f53850a80b987871727319e76f1bf7a4a1ad))
* **api:** add recurring payment activation ([af7409b](https://github.com/solana-foundation/solana-developer-platform/commit/af7409be995146f04a5842f751c46ee4a5606298))
* **payments:** confirm + cancel ramp transfers from the wizard [PRO-1395] ([#482](https://github.com/solana-foundation/solana-developer-platform/pull/482)) ([8c751d4](https://github.com/solana-foundation/solana-developer-platform/commit/8c751d488f38317c5923d134033fa6f0dc552c99))
* **kora:** move devnet config to the new KMS + Redis structure ([#484](https://github.com/solana-foundation/solana-developer-platform/pull/484)) ([a1a66a0](https://github.com/solana-foundation/solana-developer-platform/commit/a1a66a088422c90f8d1c6f22deab6aeead1d965e))
* **api:** [PRO-1360] scope API key wallet policies ([#480](https://github.com/solana-foundation/solana-developer-platform/pull/480)) ([b5bc6b9](https://github.com/solana-foundation/solana-developer-platform/commit/b5bc6b90b5524c3ee478b8779a4441a1abc36060))
* **skills:** PRO-1390 partner ramp-provider integration skills ([#479](https://github.com/solana-foundation/solana-developer-platform/pull/479)) ([96b3d98](https://github.com/solana-foundation/solana-developer-platform/commit/96b3d988fe32aaab321e3dcacc59d333b2e548e5))
* **api:** [PRO-1359] wallet operation envelope and policy evaluation engine ([#470](https://github.com/solana-foundation/solana-developer-platform/pull/470)) ([7995cc3](https://github.com/solana-foundation/solana-developer-platform/commit/7995cc3c5536db7b076f40f0d58a65d1580be860))
* **kora:** Phase-1: mainnet paymaster infra (Terraform + KMS signer + Doppler deploy) ([#455](https://github.com/solana-foundation/solana-developer-platform/pull/455)) ([d2469b5](https://github.com/solana-foundation/solana-developer-platform/commit/d2469b536af5791dfb633b6120216b4a5e4a3759))
* standardize ramp webhook verification & processing + capture settlement economics ([#478](https://github.com/solana-foundation/solana-developer-platform/pull/478)) ([ae25864](https://github.com/solana-foundation/solana-developer-platform/commit/ae25864875e5aeb9153f44cd8c52f9c438b45d9f))
* **sdp-api:** route BVNK calls through static-egress proxy ([#476](https://github.com/solana-foundation/solana-developer-platform/pull/476)) ([217e4f1](https://github.com/solana-foundation/solana-developer-platform/commit/217e4f1753224aea7ab6f0f575b0999bc13bb8a6))
* **payments:** PRO-1389 redesign on-ramp success screen ([#477](https://github.com/solana-foundation/solana-developer-platform/pull/477)) ([f5888bf](https://github.com/solana-foundation/solana-developer-platform/commit/f5888bfc2dc1a90f0eae7baf13e17742e4f4ca7d))
* **payments:** PRO-1388 wire Lightspark on-ramp estimate ([#475](https://github.com/solana-foundation/solana-developer-platform/pull/475)) ([3e51db1](https://github.com/solana-foundation/solana-developer-platform/commit/3e51db146419151b142a10f23f84c32c8a254bc8))
* **payments:** PRO-1371 gate off-ramp quote on counterparty requirements ([#474](https://github.com/solana-foundation/solana-developer-platform/pull/474)) ([ca5a2d2](https://github.com/solana-foundation/solana-developer-platform/commit/ca5a2d2176f7d28c0bb69c55765345a19d6cd1c0))

### Bug Fixes

* **payments:** isolate MoneyGram SDK DOM to prevent removeChild crash ([#494](https://github.com/solana-foundation/solana-developer-platform/pull/494)) ([8277645](https://github.com/solana-foundation/solana-developer-platform/commit/8277645da6d26fd85f116312a8f6437e9b8cc40c))
* tab highlights ([#489](https://github.com/solana-foundation/solana-developer-platform/pull/489)) ([3c0c3ec](https://github.com/solana-foundation/solana-developer-platform/commit/3c0c3ec54fd7c6bfad089904f409749f45492c7e))
* **web:** [PRO-1396] redirect counterparty not-found to list + branded 404 page ([#481](https://github.com/solana-foundation/solana-developer-platform/pull/481)) ([4c8b7b7](https://github.com/solana-foundation/solana-developer-platform/commit/4c8b7b777d7127a026e33fd9cf14445a30031b72))

### Refactors

* **sdp-api:** remove provisioning from on-ramp quotes ([#471](https://github.com/solana-foundation/solana-developer-platform/pull/471)) ([2c1cf60](https://github.com/solana-foundation/solana-developer-platform/commit/2c1cf602b941458874e61bb38c9fde3eb62c023d))
* **api:** reuse Postgres row helpers ([#468](https://github.com/solana-foundation/solana-developer-platform/pull/468)) ([0d8fc00](https://github.com/solana-foundation/solana-developer-platform/commit/0d8fc00d73caf9a790df84f1d0766000ee5152d5))

### Maintenance

* **ramp-rails:** HOO-678 enforce ramp rails matrix codegen drift ([#503](https://github.com/solana-foundation/solana-developer-platform/pull/503)) ([570e99f](https://github.com/solana-foundation/solana-developer-platform/commit/570e99ff0c17b340ce06062fb29a9fba29f822fb))
* **kora:** GCS state backend + optional WIF creation ([#483](https://github.com/solana-foundation/solana-developer-platform/pull/483)) ([549bb38](https://github.com/solana-foundation/solana-developer-platform/commit/549bb38bcc0fd01a8f36df7131782e5d41dabb69))

### Other Changes

* revert erroneous commit ([#493](https://github.com/solana-foundation/solana-developer-platform/pull/493)) ([1d22deb](https://github.com/solana-foundation/solana-developer-platform/commit/1d22debe0b8ead1b331031f4b1a32cbffea1edb3))

## [0.31.0](https://github.com/solana-foundation/solana-developer-platform/compare/v0.30.0...v0.31.0) (2026-06-18)

### Features

* **api:** PRO-1358 policy data model foundations ([#467](https://github.com/solana-foundation/solana-developer-platform/pull/467)) ([449027b](https://github.com/solana-foundation/solana-developer-platform/commit/449027bb234107b724f8bf49e97e71b4383d47bb))
* counterparty requirements advance endpoint + on-ramp onboarding flow ([#456](https://github.com/solana-foundation/solana-developer-platform/pull/456)) ([cc134ad](https://github.com/solana-foundation/solana-developer-platform/commit/cc134adb290a00aa3b5618bb177119ed93b9dd99))

### Bug Fixes

* **sdp-web:** capitalize templates, statuses and operations ([#448](https://github.com/solana-foundation/solana-developer-platform/pull/448)) ([11d149b](https://github.com/solana-foundation/solana-developer-platform/commit/11d149b2d4844f28d8b247c51cd8d8f3d504d217))
* **api-keys:** cap new key permissions to the creator's grant + tidy allowlist guard ([#433](https://github.com/solana-foundation/solana-developer-platform/pull/433)) ([61fea56](https://github.com/solana-foundation/solana-developer-platform/commit/61fea56bc9c6b8efc7cbe843658d8dc1c384a5ab))
* repair local db seed flow for fresh clones ([bb47819](https://github.com/solana-foundation/solana-developer-platform/commit/bb47819891b8ed76ac3a07b4eb98f190d68eb837))

### Refactors

* **api:** transactional email Resend cleanup ([#466](https://github.com/solana-foundation/solana-developer-platform/pull/466)) ([0468ba1](https://github.com/solana-foundation/solana-developer-platform/commit/0468ba1f28f37bd1a62b45fd7c2de59cc22754ce))

### Maintenance

* **deps:** bump the actions group across 1 directory with 2 updates ([#449](https://github.com/solana-foundation/solana-developer-platform/pull/449)) ([6c0963d](https://github.com/solana-foundation/solana-developer-platform/commit/6c0963d0763a5217bc22e17ab7984b0551dc5b15))
* **deps:** bump the minor-patch group across 1 directory with 27 updates ([#461](https://github.com/solana-foundation/solana-developer-platform/pull/461)) ([642c3fc](https://github.com/solana-foundation/solana-developer-platform/commit/642c3fc9a879dc9d2192e0b095bfc3a5f1caecae))
* **deps:** bump hono from 4.12.23 to 4.12.25 ([57ef265](https://github.com/solana-foundation/solana-developer-platform/commit/57ef2654f7b17f5eae5e5870b37a3d06b8b614bb))
* **deps-dev:** bump esbuild from 0.28.0 to 0.28.1 in /apps/sdp-api ([46a47ba](https://github.com/solana-foundation/solana-developer-platform/commit/46a47ba5f27c4d19cb36e5e4613a97f49d3d781e))
* **deps-dev:** bump esbuild from 0.28.0 to 0.28.1 ([76cf01b](https://github.com/solana-foundation/solana-developer-platform/commit/76cf01be9edc6a9f00d1334c212a8ba86334a53b))
* make secret-backed checks fork-aware ([2abfeb5](https://github.com/solana-foundation/solana-developer-platform/commit/2abfeb5a974c5ca7829b8ef9422aad037a2b09bf))

## [0.30.0](https://github.com/solana-foundation/solana-developer-platform/compare/v0.29.0...v0.30.0) (2026-06-16)

### Features

* make transactions more descriptive ([#447](https://github.com/solana-foundation/solana-developer-platform/pull/447)) ([991e22d](https://github.com/solana-foundation/solana-developer-platform/commit/991e22d5558f692608d6f4336e9cd95c3578745c))
* **issuance:** host token metadata.json so a URI is no longer required ([#424](https://github.com/solana-foundation/solana-developer-platform/pull/424)) ([8169748](https://github.com/solana-foundation/solana-developer-platform/commit/8169748fccc5b94e73c411e88b13c83a753cd9eb))

## [0.29.0](https://github.com/solana-foundation/solana-developer-platform/compare/v0.28.0...v0.29.0) (2026-06-15)

### Features

* **sdp-web, sdp-docs, sdp-api:** HOO-473 - Unify amount fields across Web, Docs, and API to use decimals ([#435](https://github.com/solana-foundation/solana-developer-platform/pull/435)) ([fce66f8](https://github.com/solana-foundation/solana-developer-platform/commit/fce66f83eca743a66fe0a68371d5ce174f1819cd))
* **sdp-web:** HOO-579 Show token names instead of addresses ([#438](https://github.com/solana-foundation/solana-developer-platform/pull/438)) ([86fc654](https://github.com/solana-foundation/solana-developer-platform/commit/86fc654901ff6db029bf4eef3b53d6a2e166e1d4))
* add in estimation endpoint through quote + estimate for BVNK ([#446](https://github.com/solana-foundation/solana-developer-platform/pull/446)) ([655b4e1](https://github.com/solana-foundation/solana-developer-platform/commit/655b4e1e0bf9e85660b9d73dbaba4f3721e9a470))
* **counterparty:** autocomplete addresses with Google Places ([#439](https://github.com/solana-foundation/solana-developer-platform/pull/439)) ([0e39798](https://github.com/solana-foundation/solana-developer-platform/commit/0e3979827e7cdaa27bb13e80221bf70f18fd56d7))
* **ramps:** show recent transaction history for the selected counterparty ([#437](https://github.com/solana-foundation/solana-developer-platform/pull/437)) ([05f0c28](https://github.com/solana-foundation/solana-developer-platform/commit/05f0c2852f701050d570a0f81a6dc54e3cdaead2))
* **ramps:** lightspark off-ramp via payout requirements and realtime-funded quotes ([#434](https://github.com/solana-foundation/solana-developer-platform/pull/434)) ([2e02ffb](https://github.com/solana-foundation/solana-developer-platform/commit/2e02ffbec8dde2cd69a7def35aead2d0c7ce58eb))
* **self-hosted:** encode the custody key as base64 in the configurator ([#430](https://github.com/solana-foundation/solana-developer-platform/pull/430)) ([855fc2c](https://github.com/solana-foundation/solana-developer-platform/commit/855fc2c863126cccf4c6f5f910fd0eb786e1fd07))
* **self-hosted:** cover the full wallet path in the nightly smoke ([#429](https://github.com/solana-foundation/solana-developer-platform/pull/429)) ([77b31db](https://github.com/solana-foundation/solana-developer-platform/commit/77b31dbef98b410d7389d69757c14e3e44adc5f2))

### Bug Fixes

* **places:** harden Google error parsing and session token rotation ([#441](https://github.com/solana-foundation/solana-developer-platform/pull/441)) ([a001faf](https://github.com/solana-foundation/solana-developer-platform/commit/a001faf923f31b5be52fc958ff97f6e3a12ce284))

### Documentation

* add self-hosted devnet onboarding ([#436](https://github.com/solana-foundation/solana-developer-platform/pull/436)) ([6bf27f8](https://github.com/solana-foundation/solana-developer-platform/commit/6bf27f8c51c7977a86039a8a46e2ee6b4fd13f62))

### Maintenance

* rename missingApiKeys to avoid CodeQL clear-text-logging false positive ([#440](https://github.com/solana-foundation/solana-developer-platform/pull/440)) ([8f1beb7](https://github.com/solana-foundation/solana-developer-platform/commit/8f1beb732c124c4b5c834390e34829b389c0930e))
* refactor ramps to use correct utils and have cleaner code separation for requirements for api ([#432](https://github.com/solana-foundation/solana-developer-platform/pull/432)) ([ef892ab](https://github.com/solana-foundation/solana-developer-platform/commit/ef892abcedf66e359ab9e42dc048ae331a65ce4e))

### Other Changes

* fix dfns wallet key reuse ([#451](https://github.com/solana-foundation/solana-developer-platform/pull/451)) ([e922be2](https://github.com/solana-foundation/solana-developer-platform/commit/e922be2a5e0fbc44053bce00c0f33be407924d9f))

## [0.28.0](https://github.com/solana-foundation/solana-developer-platform/compare/v0.27.0...v0.28.0) (2026-06-10)

### Features

* **ramps:** provider-driven counterparty requirements + JIT KYC passthrough [PRO-1305] ([#423](https://github.com/solana-foundation/solana-developer-platform/pull/423)) ([7fe605d](https://github.com/solana-foundation/solana-developer-platform/commit/7fe605d9f6f671d783517eef7c0d09b2ebe87dc8))

### Bug Fixes

* remove reserved claim "sub" from clerk jwt template ([#421](https://github.com/solana-foundation/solana-developer-platform/pull/421)) ([00ff2f1](https://github.com/solana-foundation/solana-developer-platform/commit/00ff2f1ee3d9ee45edb69cb74b750f70c3fc1391))

### Documentation

* **sdp-docs:** add Issue a Regulated Stablecoin tutorial ([#319](https://github.com/solana-foundation/solana-developer-platform/pull/319)) ([93d260a](https://github.com/solana-foundation/solana-developer-platform/commit/93d260a68b8b37c78e5dcaa96e8dd67bd935901d))
* **sdp-docs:** add Tokenize a Treasury Fund tutorial ([e682783](https://github.com/solana-foundation/solana-developer-platform/commit/e68278357d5454b7d70a3082ec2a5858df4982ae))

### Maintenance

* **deps:** bump the actions group across 1 directory with 3 updates ([#426](https://github.com/solana-foundation/solana-developer-platform/pull/426)) ([85c2535](https://github.com/solana-foundation/solana-developer-platform/commit/85c2535bec671949287b72d35c70d87b8ade5717))
* **deps:** bump the minor-patch group with 22 updates ([#417](https://github.com/solana-foundation/solana-developer-platform/pull/417)) ([5b9c96c](https://github.com/solana-foundation/solana-developer-platform/commit/5b9c96ce395581df0607088753ab5588c280bef3))
* **deps:** bump @solana-program/system ([#416](https://github.com/solana-foundation/solana-developer-platform/pull/416)) ([65dc1e5](https://github.com/solana-foundation/solana-developer-platform/commit/65dc1e568a696b24db81dcd8f382049975b09e4f))

## [0.27.0](https://github.com/solana-foundation/solana-developer-platform/compare/v0.26.0...v0.27.0) (2026-06-09)

### Features

* **self-hosted:** publish env template as default.env.example ([#425](https://github.com/solana-foundation/solana-developer-platform/pull/425)) ([21d9ccb](https://github.com/solana-foundation/solana-developer-platform/commit/21d9ccb9b35dc76f0b4252650a4172e4a608cb98))
* **sdp-web:** HOO-491 Surface why mint/burn is disabled in token modal ([#403](https://github.com/solana-foundation/solana-developer-platform/pull/403)) ([8107db8](https://github.com/solana-foundation/solana-developer-platform/commit/8107db8065fe425102a40070540bcd67b4dd8198))
* HOO-520 self-hosting docs section + .env configurator optimization ([#410](https://github.com/solana-foundation/solana-developer-platform/pull/410)) ([272265f](https://github.com/solana-foundation/solana-developer-platform/commit/272265f173cd1cf5bf2e2b5ca864d58c4897b4b2))
* **payments:** add recurring payment records API [PRO-1294] ([#415](https://github.com/solana-foundation/solana-developer-platform/pull/415)) ([8310f95](https://github.com/solana-foundation/solana-developer-platform/commit/8310f9539cd347db7b2e5520120886f53bdfea7d))

### Bug Fixes

* ensure bvnk ui instruction comes from backend only ([#418](https://github.com/solana-foundation/solana-developer-platform/pull/418)) ([4422f3b](https://github.com/solana-foundation/solana-developer-platform/commit/4422f3bdf340ff7b58349b0ec5866df81e797f8c))

### Maintenance

* **self-hosted:** HOO-522 nightly smoke test on clean Ubuntu ([#422](https://github.com/solana-foundation/solana-developer-platform/pull/422)) ([2c095b1](https://github.com/solana-foundation/solana-developer-platform/commit/2c095b13b0b680272969c6af6cf04e7bbde70e88))
* **deps:** bump the actions group with 6 updates ([#395](https://github.com/solana-foundation/solana-developer-platform/pull/395)) ([b944ba3](https://github.com/solana-foundation/solana-developer-platform/commit/b944ba3923ea0c1d2e347d66e5d1b1b2475b4abf))

## [0.26.0](https://github.com/solana-foundation/solana-developer-platform/compare/v0.25.0...v0.26.0) (2026-06-05)

### Features

* transaction reconciliation and transaction history ([#413](https://github.com/solana-foundation/solana-developer-platform/pull/413)) ([9bc06d0](https://github.com/solana-foundation/solana-developer-platform/commit/9bc06d0e937f4a6d9d3816242116877b1511546f))
* add Payments v2 dashboard cookie toggle ([#412](https://github.com/solana-foundation/solana-developer-platform/pull/412)) ([71a86f1](https://github.com/solana-foundation/solana-developer-platform/commit/71a86f1e73a4a09e5542ddbc281a232620067710))
* add in estimates for on/offramp ([#411](https://github.com/solana-foundation/solana-developer-platform/pull/411)) ([9ec2610](https://github.com/solana-foundation/solana-developer-platform/commit/9ec2610b0bb199616a4a975941b8533c38ef4c8c))
* add Solana subscription primitives ([#406](https://github.com/solana-foundation/solana-developer-platform/pull/406)) ([cbd77f1](https://github.com/solana-foundation/solana-developer-platform/commit/cbd77f17c1c359af36a24dc87110a654ebd8bcf6))
* add counterparty crypto-wallet accounts ([#405](https://github.com/solana-foundation/solana-developer-platform/pull/405)) ([acfd833](https://github.com/solana-foundation/solana-developer-platform/commit/acfd83308edb8e868f5d8acc48c983367fd63e07))
* **onramp:** BVNK fiat→crypto on-ramp with KYC onboarding + verification webhooks ([#404](https://github.com/solana-foundation/solana-developer-platform/pull/404)) ([627eaa5](https://github.com/solana-foundation/solana-developer-platform/commit/627eaa57fa64e6ab365aee3e083eaf56f39fbdf5))
* onchain transfers in payments v2 deposit/pay flows ([#401](https://github.com/solana-foundation/solana-developer-platform/pull/401)) ([00f21c2](https://github.com/solana-foundation/solana-developer-platform/commit/00f21c2c09461549459a2a347bb733f9793eaa4a))

## [0.25.0](https://github.com/solana-foundation/solana-developer-platform/compare/v0.24.0...v0.25.0) (2026-06-03)

### Features

* HOO-519 bootstrap install script for self-hosted deployments ([#394](https://github.com/solana-foundation/solana-developer-platform/pull/394)) ([57febae](https://github.com/solana-foundation/solana-developer-platform/commit/57febae5dc7e63c2185403f300425747bfdc44a8))
* add Utila custody signer ([#386](https://github.com/solana-foundation/solana-developer-platform/pull/386)) ([bef8bf8](https://github.com/solana-foundation/solana-developer-platform/commit/bef8bf8633ae1a213f2d2480c51ac103e66b7fe9))
* **counterparty:** payment accounts CRUD + manage page ([#399](https://github.com/solana-foundation/solana-developer-platform/pull/399)) ([adf948d](https://github.com/solana-foundation/solana-developer-platform/commit/adf948d8e9282def8851f621a334be5670eb9cc2))
* cleanup payments for sdp-api ([#397](https://github.com/solana-foundation/solana-developer-platform/pull/397)) ([a085037](https://github.com/solana-foundation/solana-developer-platform/commit/a08503712e8dd32c2888d3305bd345a0ec846779))
* **sdp-api:** Kora sponsor sRFC-37 token deployment ([#387](https://github.com/solana-foundation/solana-developer-platform/pull/387)) ([e63c2bb](https://github.com/solana-foundation/solana-developer-platform/commit/e63c2bbb482fd9183bedc928f19df90efcbede77))

### Documentation

* add self-hosted co-signer hosting guidance ([#390](https://github.com/solana-foundation/solana-developer-platform/pull/390)) ([6b613da](https://github.com/solana-foundation/solana-developer-platform/commit/6b613da4b0397141f97ff9348d47079d6377b7a6))

### Maintenance

* rearrange ramps file structure and also just scaffold moonpay … ([#396](https://github.com/solana-foundation/solana-developer-platform/pull/396)) ([35b6423](https://github.com/solana-foundation/solana-developer-platform/commit/35b64235fc36135e4100fa8219c40014a7291b51))

## [0.24.0](https://github.com/solana-foundation/solana-developer-platform/compare/v0.23.0...v0.24.0) (2026-06-02)

### Features

* HOO-600 support plugins in createApp and extensible env fallback keys ([#389](https://github.com/solana-foundation/solana-developer-platform/pull/389)) ([468349e](https://github.com/solana-foundation/solana-developer-platform/commit/468349e2661ef012bbed5efa6b66da87e505cacf))
* add in webhook processing ([#388](https://github.com/solana-foundation/solana-developer-platform/pull/388)) ([b6f480e](https://github.com/solana-foundation/solana-developer-platform/commit/b6f480ec606eccf5c63dffeaed63cfd251b6ba39))
* configure onramp base ([#385](https://github.com/solana-foundation/solana-developer-platform/pull/385)) ([1e61b6c](https://github.com/solana-foundation/solana-developer-platform/commit/1e61b6c446109c883c432cfbb182c5c4ba134431))
* HOO-521 self-hosted .env configurator (docs page + CLI) ([#379](https://github.com/solana-foundation/solana-developer-platform/pull/379)) ([e66e1ff](https://github.com/solana-foundation/solana-developer-platform/commit/e66e1ff2543e7fc5727661446c9ed5b48b259cbc))
* add in counterparty dropdown selection ([#378](https://github.com/solana-foundation/solana-developer-platform/pull/378)) ([e1247e4](https://github.com/solana-foundation/solana-developer-platform/commit/e1247e4a8df8109d1eaa2ea809785b81a62033ad))
* HOO-524 CD pipeline + self-hosted runtime-configurable images ([#373](https://github.com/solana-foundation/solana-developer-platform/pull/373)) ([cb1e6ac](https://github.com/solana-foundation/solana-developer-platform/commit/cb1e6acaab42edb7d8ef791158fd53b449a9b8b0))
* payments onramp v2 provider discovery ([#374](https://github.com/solana-foundation/solana-developer-platform/pull/374)) ([4c50b71](https://github.com/solana-foundation/solana-developer-platform/commit/4c50b71e9bd98b206aedbfa29232a87bbcc2dfe6))

### Bug Fixes

* batch Cloudflare Worker secret uploads ([#391](https://github.com/solana-foundation/solana-developer-platform/pull/391)) ([21f17bc](https://github.com/solana-foundation/solana-developer-platform/commit/21f17bc3ae5d9654060006a0e91ee5016a8b9262))
* HOO-585 enforce project boundary in token reads and project scope ([#375](https://github.com/solana-foundation/solana-developer-platform/pull/375)) ([d2da9f3](https://github.com/solana-foundation/solana-developer-platform/commit/d2da9f3cde773134e512626a1fef5578bd2e3c21))
* **sdp-api:** HOO-461 Auto-add mint destinations to on-chain allowlist ([#317](https://github.com/solana-foundation/solana-developer-platform/pull/317)) ([29bfd4a](https://github.com/solana-foundation/solana-developer-platform/commit/29bfd4a4b2cb0e1fa5652607c4b647d759fdba99))

### Maintenance

* **deps:** bump the minor-patch group across 1 directory with 21 updates ([#381](https://github.com/solana-foundation/solana-developer-platform/pull/381)) ([0a75c68](https://github.com/solana-foundation/solana-developer-platform/commit/0a75c684ba42e2ad2188d5beb93ab5853de33399))
* **deps-dev:** bump @testcontainers/redis from 11.14.0 to 12.0.0 ([#384](https://github.com/solana-foundation/solana-developer-platform/pull/384)) ([2a60fde](https://github.com/solana-foundation/solana-developer-platform/commit/2a60fdec50b34c769cf736bb48038cf6e2959ae3))
* **deps-dev:** bump @testcontainers/postgresql from 11.14.0 to 12.0.0 ([#383](https://github.com/solana-foundation/solana-developer-platform/pull/383)) ([c95f8e0](https://github.com/solana-foundation/solana-developer-platform/commit/c95f8e07882d281e330734d0a57172d4c7ffbab6))
* **deps-dev:** bump testcontainers from 11.14.0 to 12.0.0 ([#382](https://github.com/solana-foundation/solana-developer-platform/pull/382)) ([ef06e18](https://github.com/solana-foundation/solana-developer-platform/commit/ef06e181e2a0fa39107e0dfdaedec5e7610b244e))
* **deps:** bump @solana-program/system in the solana group ([#380](https://github.com/solana-foundation/solana-developer-platform/pull/380)) ([85679aa](https://github.com/solana-foundation/solana-developer-platform/commit/85679aa30fbc23728be4fa410ab3be16664fed7e))

## [0.23.0](https://github.com/solana-foundation/solana-developer-platform/compare/v0.22.0...v0.23.0) (2026-05-29)

### Features

* enable pay/deposit routes behind FF ([#371](https://github.com/solana-foundation/solana-developer-platform/pull/371)) ([0255378](https://github.com/solana-foundation/solana-developer-platform/commit/02553789528098241c4ae14f603b516db6e8711d))
* ramps provider support currency unified support ([#370](https://github.com/solana-foundation/solana-developer-platform/pull/370)) ([7184d0f](https://github.com/solana-foundation/solana-developer-platform/commit/7184d0fe92ce36baffb7f62e9895db5d28bf24ed))

### Bug Fixes

* ensure users cannot enter production mode ([#368](https://github.com/solana-foundation/solana-developer-platform/pull/368)) ([19347ac](https://github.com/solana-foundation/solana-developer-platform/commit/19347acd4e311520783a86e1b2dfdbac0feb7d5a))

### Documentation

* Redesign/docs platform solana com ([#313](https://github.com/solana-foundation/solana-developer-platform/pull/313)) ([d9e0c91](https://github.com/solana-foundation/solana-developer-platform/commit/d9e0c9127e84ed0de14bd677ad24db2c8df06e81))

## [0.22.0](https://github.com/solana-foundation/solana-developer-platform/compare/v0.21.0...v0.22.0) (2026-05-28)

### Features

* hide payments submenu behind flag ([#367](https://github.com/solana-foundation/solana-developer-platform/pull/367)) ([42a7703](https://github.com/solana-foundation/solana-developer-platform/commit/42a77031829c90999c5e91fc637c174bc70f56c5))
* HOO-554 Simplify wallet provider selection ([#330](https://github.com/solana-foundation/solana-developer-platform/pull/330)) ([bf00393](https://github.com/solana-foundation/solana-developer-platform/commit/bf00393fe6b60fbf1aea5059dd788c651a5cb6d6))
* HOO-517 node-mode scripts + docker secrets export ([#363](https://github.com/solana-foundation/solana-developer-platform/pull/363)) ([cc8fc84](https://github.com/solana-foundation/solana-developer-platform/commit/cc8fc841101452b627a3a88047c95444e2bcefc4))
* model counterparty accounts ([#365](https://github.com/solana-foundation/solana-developer-platform/pull/365)) ([8a35b15](https://github.com/solana-foundation/solana-developer-platform/commit/8a35b150eb5a685b912d7275ab6e3f60b5eabea0))
* add base MagicBlock private transfers API ([#357](https://github.com/solana-foundation/solana-developer-platform/pull/357)) ([6939e75](https://github.com/solana-foundation/solana-developer-platform/commit/6939e75ad19c24c4857c4c1ab9117b581e364b3e))
* **ci:** HOO-518 docker_build_web smoke + GHA layer cache ([#361](https://github.com/solana-foundation/solana-developer-platform/pull/361)) ([d5ef0de](https://github.com/solana-foundation/solana-developer-platform/commit/d5ef0de058fa49b7d2a5a5c36b59b255907d06a8))
* **sdp-api:** HOO-516 vitest pool split + integration env decoupling ([#356](https://github.com/solana-foundation/solana-developer-platform/pull/356)) ([550a698](https://github.com/solana-foundation/solana-developer-platform/commit/550a69818ff2d270bfc982e6bc0c66b6c53552d3))

### Bug Fixes

* sponsor MagicBlock gasless transfers with Kora ([#366](https://github.com/solana-foundation/solana-developer-platform/pull/366)) ([58f52ca](https://github.com/solana-foundation/solana-developer-platform/commit/58f52cac6c48dce04859edbc1e6caf89493a3315))
* dashboard loading boundary to use suspense component ([#364](https://github.com/solana-foundation/solana-developer-platform/pull/364)) ([e62e162](https://github.com/solana-foundation/solana-developer-platform/commit/e62e1620d0d783bb3039227cc37b75bc156267be))
* environment and project boundary ([#362](https://github.com/solana-foundation/solana-developer-platform/pull/362)) ([0b668d5](https://github.com/solana-foundation/solana-developer-platform/commit/0b668d5b65a24161360a9c6f282cee9074d0d5d0))

### Other Changes

* Update wallet listing and card metadata UX ([#360](https://github.com/solana-foundation/solana-developer-platform/pull/360)) ([2e57806](https://github.com/solana-foundation/solana-developer-platform/commit/2e5780630d437ea61b2f79cdd757fbce4df22569))

## [0.21.0](https://github.com/solana-foundation/solana-developer-platform/compare/v0.20.0...v0.21.0) (2026-05-26)

### Features

* **pro-1222:** counterparty management page ([#354](https://github.com/solana-foundation/solana-developer-platform/pull/354)) ([aff317c](https://github.com/solana-foundation/solana-developer-platform/commit/aff317c34559e9a3f39018932dcdd90ff49f315f))
* **pro-1250:** add in counterparty openapi schema ([#348](https://github.com/solana-foundation/solana-developer-platform/pull/348)) ([0524ec4](https://github.com/solana-foundation/solana-developer-platform/commit/0524ec43e95cfef5aec960315efd9649538c355e))
* HOO-515 docker compose for local dev + CI smoke ([#349](https://github.com/solana-foundation/solana-developer-platform/pull/349)) ([d0a8a08](https://github.com/solana-foundation/solana-developer-platform/commit/d0a8a08003a5e16fac24bd3b6212b29d87745024))
* **types:** model MagicBlock private transfer routing ([#347](https://github.com/solana-foundation/solana-developer-platform/pull/347)) ([f9bde8b](https://github.com/solana-foundation/solana-developer-platform/commit/f9bde8bc84c51fa5924f0ce54d255b6ccc70d399))
* **pro-1219:** adding crud endpoints for counterparty ([#338](https://github.com/solana-foundation/solana-developer-platform/pull/338)) ([81c64b4](https://github.com/solana-foundation/solana-developer-platform/commit/81c64b49b18d6f8e660f1dfe41c75b7196bdf991))
* **sdp-docs:** HOO-514 Dockerfile + CI smoke build ([#346](https://github.com/solana-foundation/solana-developer-platform/pull/346)) ([07c579b](https://github.com/solana-foundation/solana-developer-platform/commit/07c579b6247fcd54fe79ac4ea7414d2597f68203))

### Documentation

* HOO-439 update solana payment docs ([#305](https://github.com/solana-foundation/solana-developer-platform/pull/305)) ([dc2c997](https://github.com/solana-foundation/solana-developer-platform/commit/dc2c9971dc7ccbeafa025409656a77f311e5215b))

### Maintenance

* **deps:** bump the minor-patch group across 1 directory with 31 updates ([#353](https://github.com/solana-foundation/solana-developer-platform/pull/353)) ([eaf4543](https://github.com/solana-foundation/solana-developer-platform/commit/eaf4543623233f8929868bb128ff6c546017d4a2))
* **deps:** bump @hono/node-server from 1.19.14 to 2.0.2 ([d6aa61f](https://github.com/solana-foundation/solana-developer-platform/commit/d6aa61f17440f8379b7573ccfe37861e571c6ec0))
* **deps:** bump fumadocs-mdx from 14.3.2 to 15.0.6 ([134576c](https://github.com/solana-foundation/solana-developer-platform/commit/134576ce3e10b4953a8442a3d3d8f66e331fd991))
* **deps:** bump the actions group with 2 updates ([7b9f5cb](https://github.com/solana-foundation/solana-developer-platform/commit/7b9f5cb97507cfecb69e3171720861637e4f6986))
* **deps:** align Dependabot cooldown with pnpm age guard ([#337](https://github.com/solana-foundation/solana-developer-platform/pull/337)) ([4520cec](https://github.com/solana-foundation/solana-developer-platform/commit/4520cecac0de13ae81b38d4aaa858c378505e882))

### Other Changes

* Allow MagicBlock program in Kora config ([#355](https://github.com/solana-foundation/solana-developer-platform/pull/355)) ([bb29c33](https://github.com/solana-foundation/solana-developer-platform/commit/bb29c331d681e91b4deaa598640de040430364cf))

## [0.20.0](https://github.com/solana-foundation/solana-developer-platform/releases/tag/v0.20.0) (2026-05-22)

### Features

* **pro-1218:** counterparty model migration on database ([#331](https://github.com/solana-foundation/solana-developer-platform/pull/331)) ([8f99178](https://github.com/solana-foundation/solana-developer-platform/commit/8f99178d34119a5d4f87d5a4919b4d94a86700d9))
* **sdp-api:** HOO-512 Node Dockerfile + CI smoke build ([#329](https://github.com/solana-foundation/solana-developer-platform/pull/329)) ([7f32be8](https://github.com/solana-foundation/solana-developer-platform/commit/7f32be8bc4f9390ef6853e82fa9690cc42111527))
* **sdp-api:** HOO-511 Node.js entrypoint (server.ts) ([#327](https://github.com/solana-foundation/solana-developer-platform/pull/327)) ([b75f7a1](https://github.com/solana-foundation/solana-developer-platform/commit/b75f7a1a4fb681c161e5f606f77e376d9f012f09))
* **sdp-api:** HOO-510 RedisKVStore for Node runtime ([#318](https://github.com/solana-foundation/solana-developer-platform/pull/318)) ([2154ae2](https://github.com/solana-foundation/solana-developer-platform/commit/2154ae2702b1c092459041c02754f650985ba0b0))
* **pro-1202:** add test mode indicator and toggle ([#315](https://github.com/solana-foundation/solana-developer-platform/pull/315)) ([6b41f01](https://github.com/solana-foundation/solana-developer-platform/commit/6b41f017541e869dfb5b021fccb3a07ea7a6bb60))
* **sdp-web:** HOO-513 Dockerfile + Next.js standalone output ([#316](https://github.com/solana-foundation/solana-developer-platform/pull/316)) ([9f41f80](https://github.com/solana-foundation/solana-developer-platform/commit/9f41f80fdaf4bb75be522340c31cb56363ed7aa1))
* HOO-486 Add issuance transactions to wallet activity ([#302](https://github.com/solana-foundation/solana-developer-platform/pull/302)) ([bbe2cd1](https://github.com/solana-foundation/solana-developer-platform/commit/bbe2cd1cf3603a97ed07583d45030aab54a97b87))
* **sdp-web:** HOO-490 expose tokenId and token selector in issuance API playground ([#295](https://github.com/solana-foundation/solana-developer-platform/pull/295)) ([2994b5d](https://github.com/solana-foundation/solana-developer-platform/commit/2994b5ddd4cacbb15337314555c30a22aa7a9895))

### Bug Fixes

* onramp flow for lightspark ([#321](https://github.com/solana-foundation/solana-developer-platform/pull/321)) ([a2e8a83](https://github.com/solana-foundation/solana-developer-platform/commit/a2e8a8383c0ceb50adf11fe3003c446ff9110f0e))
* allow sandbox configuration for all ramps providers ([#308](https://github.com/solana-foundation/solana-developer-platform/pull/308)) ([fa440d5](https://github.com/solana-foundation/solana-developer-platform/commit/fa440d539c1de2c299412d47f67a76dc98068a28))
* **sdp-api:** HOO-507 harden NodeBackgroundRunner for SIGTERM drain ([#304](https://github.com/solana-foundation/solana-developer-platform/pull/304)) ([18e503b](https://github.com/solana-foundation/solana-developer-platform/commit/18e503bc96528e52a450f166bf759b805bbdd95d))
* Clear and refetch wallet data when switching organizations ([#306](https://github.com/solana-foundation/solana-developer-platform/pull/306)) ([76ead79](https://github.com/solana-foundation/solana-developer-platform/commit/76ead7922ef9ad67546949db0e535f5f6cc007b9))

### Documentation

* add concise oss onboarding ([1070078](https://github.com/solana-foundation/solana-developer-platform/commit/107007870f93c05d0e34c224b97adf338abe73e9))
* simplify public readme ([3a65cfc](https://github.com/solana-foundation/solana-developer-platform/commit/3a65cfc0271287200107e9ae8c7a7a69d9148a1e))

### Refactors

* **sdp-api:** HOO-509 split index.ts → app.ts + extract cron function ([#312](https://github.com/solana-foundation/solana-developer-platform/pull/312)) ([8c1c165](https://github.com/solana-foundation/solana-developer-platform/commit/8c1c16559761169a0fc0e53c483bfa0cd6926c21))
* **sdp-api:** HOO-508 unify Sentry across runtimes via observability module ([#307](https://github.com/solana-foundation/solana-developer-platform/pull/307)) ([88110ea](https://github.com/solana-foundation/solana-developer-platform/commit/88110ea291cc6c578a9a2c501eea870d2474acc1))
* **sdp-api:** HOO-506 KVStore interface + WorkersKVStore implementation ([#300](https://github.com/solana-foundation/solana-developer-platform/pull/300)) ([e84cf7e](https://github.com/solana-foundation/solana-developer-platform/commit/e84cf7ea9c8c39f573e7d9e732582df8c26a60e4))
* **sdp-api:** HOO-505 make CF bindings optional in TypeScript ([#296](https://github.com/solana-foundation/solana-developer-platform/pull/296)) ([305f2a9](https://github.com/solana-foundation/solana-developer-platform/commit/305f2a919578e4de8948a58b9db6b25dd151383d))

### Maintenance

* **compliance:** clean up compliance schemas ([#303](https://github.com/solana-foundation/solana-developer-platform/pull/303)) ([6d7cd0f](https://github.com/solana-foundation/solana-developer-platform/commit/6d7cd0f7e6b4a75b457332ef7a748522bec45d2b))
* **sdp-api:** clean up openapi types for payments ([#301](https://github.com/solana-foundation/solana-developer-platform/pull/301)) ([14ade4c](https://github.com/solana-foundation/solana-developer-platform/commit/14ade4ca7a3f9b71cb19c5b0f0a1fa0b956aae9a))
* **main:** upgrade Next to 16.2.6 ([#299](https://github.com/solana-foundation/solana-developer-platform/pull/299)) ([e905650](https://github.com/solana-foundation/solana-developer-platform/commit/e905650defc4c7244abb9d296bdb8287d0c18cce))
* enforce pnpm release age gate ([#297](https://github.com/solana-foundation/solana-developer-platform/pull/297)) ([fb6b462](https://github.com/solana-foundation/solana-developer-platform/commit/fb6b462d667517372123c2a2518d1a5f8a8af71d))
* initial open source snapshot ([ec00280](https://github.com/solana-foundation/solana-developer-platform/commit/ec00280bdbec28f2947dcebf771dd44f4afdb559))

## [0.19.4](https://github.com/solana-foundation/solana-developer-platform/compare/v0.19.3...v0.19.4) (2026-05-09)

### Maintenance

* **deps:** bump the minor-patch group across 1 directory with 8 updates ([#286](https://github.com/solana-foundation/solana-developer-platform/pull/286)) ([c2a2c15](https://github.com/solana-foundation/solana-developer-platform/commit/c2a2c15690d2270ea84968bdd94b26422318cd0b))

## [0.19.3](https://github.com/solana-foundation/solana-developer-platform/compare/v0.19.2...v0.19.3) (2026-05-09)

### Bug Fixes

* **kora:** allow sRFC-37 programs ([#277](https://github.com/solana-foundation/solana-developer-platform/pull/277)) ([fd354c4](https://github.com/solana-foundation/solana-developer-platform/commit/fd354c4f4def9c77acbe5e9070a8e2deff50dd48))

### Maintenance

* **deps:** bump fast-uri from 3.1.0 to 3.1.2 ([#285](https://github.com/solana-foundation/solana-developer-platform/pull/285)) ([508d90d](https://github.com/solana-foundation/solana-developer-platform/commit/508d90db850a3ced6b8008cc2de5a1d04872e1b1))
* **deps:** bundle Dependabot updates ([#282](https://github.com/solana-foundation/solana-developer-platform/pull/282)) ([1e0e6c4](https://github.com/solana-foundation/solana-developer-platform/commit/1e0e6c49a9cae1484ae56a48564130262462c062))

## [0.19.2](https://github.com/solana-foundation/solana-developer-platform/compare/v0.19.1...v0.19.2) (2026-05-08)

### Bug Fixes

* HOO-460 support denylist for security tokens ([#267](https://github.com/solana-foundation/solana-developer-platform/pull/267)) ([5facd5c](https://github.com/solana-foundation/solana-developer-platform/commit/5facd5c25e2b4bca455face40b3f073840abf321))

### Other Changes

* Remove stale D1 mentions ([#273](https://github.com/solana-foundation/solana-developer-platform/pull/273)) ([7ee81e8](https://github.com/solana-foundation/solana-developer-platform/commit/7ee81e83c935049c01207cebddf3de084eed8c0a))

## [0.19.1](https://github.com/solana-foundation/solana-developer-platform/compare/v0.19.0...v0.19.1) (2026-05-06)

### Maintenance

* **sdp-api:** isolate test DB via TEST_DATABASE_URL and miniflare hyperdrives ([#270](https://github.com/solana-foundation/solana-developer-platform/pull/270)) ([4a4434a](https://github.com/solana-foundation/solana-developer-platform/commit/4a4434a6dae88db2ad501ec094ff97e1324bd51c))

## [0.19.0](https://github.com/solana-foundation/solana-developer-platform/compare/v0.18.8...v0.19.0) (2026-05-05)

### Features

* use stable layout when transitioning ([#268](https://github.com/solana-foundation/solana-developer-platform/pull/268)) ([4140375](https://github.com/solana-foundation/solana-developer-platform/commit/41403752ade9d9378f7908409e8d5b5388cd3b23))
* API Debug Mode for local/staging development ([#263](https://github.com/solana-foundation/solana-developer-platform/pull/263)) ([4806df7](https://github.com/solana-foundation/solana-developer-platform/commit/4806df746a9f742be8f2a40fbfec8be5aae91951))

### Refactors

* add domain operation modules ([#261](https://github.com/solana-foundation/solana-developer-platform/pull/261)) ([c6c7e9d](https://github.com/solana-foundation/solana-developer-platform/commit/c6c7e9dd9fc19388c931a1150f0a93a764ef7ddb))
* add token operation module ([#258](https://github.com/solana-foundation/solana-developer-platform/pull/258)) ([1607bf8](https://github.com/solana-foundation/solana-developer-platform/commit/1607bf8d9987c13fdf349bf10fb5639225d2d58d))

## [0.18.8](https://github.com/solana-foundation/solana-developer-platform/compare/v0.18.7...v0.18.8) (2026-05-01)

### Other Changes

* Refactor provider availability module ([#257](https://github.com/solana-foundation/solana-developer-platform/pull/257)) ([ae99963](https://github.com/solana-foundation/solana-developer-platform/commit/ae99963342d8bf3cf769d75aa47ea17e5aaae09c))

## [0.18.7](https://github.com/solana-foundation/solana-developer-platform/compare/v0.18.6...v0.18.7) (2026-05-01)

### Other Changes

* fix provider onboarding pdf rewrites ([#255](https://github.com/solana-foundation/solana-developer-platform/pull/255)) ([79d6eae](https://github.com/solana-foundation/solana-developer-platform/commit/79d6eaea4d4ffe739272eb2a928078291526b99f))

## [0.18.6](https://github.com/solana-foundation/solana-developer-platform/compare/v0.18.5...v0.18.6) (2026-04-30)

### Bug Fixes

* improve Mint/Burn modal dismissal ([#251](https://github.com/solana-foundation/solana-developer-platform/pull/251)) ([bfd9cd7](https://github.com/solana-foundation/solana-developer-platform/commit/bfd9cd73388589393e73196b7314ad2d61120e51))
* allow ecosystem clerk redirects ([#252](https://github.com/solana-foundation/solana-developer-platform/pull/252)) ([2fd3b76](https://github.com/solana-foundation/solana-developer-platform/commit/2fd3b762ff4c3bed92a226bd38dbd3a15ce79acc))

### Maintenance

* **deps:** bump @clerk/nextjs from 7.2.3 to 7.2.4 in /apps/sdp-web ([#247](https://github.com/solana-foundation/solana-developer-platform/pull/247)) ([eb7a405](https://github.com/solana-foundation/solana-developer-platform/commit/eb7a40529b5f4edeebadd42468f02ab38ab7272b))
* **deps-dev:** bump @clerk/backend from 3.2.13 to 3.2.14 ([#250](https://github.com/solana-foundation/solana-developer-platform/pull/250)) ([765b6e8](https://github.com/solana-foundation/solana-developer-platform/commit/765b6e89bc0ab0a997603951bcfc8ada1966d83a))

## [0.18.5](https://github.com/solana-foundation/solana-developer-platform/compare/v0.18.4...v0.18.5) (2026-04-30)

### Documentation

* update infrastructure provider onboarding ([#244](https://github.com/solana-foundation/solana-developer-platform/pull/244)) ([39dd66d](https://github.com/solana-foundation/solana-developer-platform/commit/39dd66d37a650ea4c022294b80518090f07f2acb))

## [0.18.4](https://github.com/solana-foundation/solana-developer-platform/compare/v0.18.3...v0.18.4) (2026-04-29)

### Bug Fixes

* round robin faucet and align action toasts ([#243](https://github.com/solana-foundation/solana-developer-platform/pull/243)) ([f320d66](https://github.com/solana-foundation/solana-developer-platform/commit/f320d6632cf34de2afb64b3213882e358bcb936d))

## [0.18.3](https://github.com/solana-foundation/solana-developer-platform/compare/v0.18.2...v0.18.3) (2026-04-29)

### Bug Fixes

* **api:** render Worker vars from Doppler ([#242](https://github.com/solana-foundation/solana-developer-platform/pull/242)) ([0b94ef0](https://github.com/solana-foundation/solana-developer-platform/commit/0b94ef028d14c76d59301da29a4396f6ad1e1c07))

## [0.18.2](https://github.com/solana-foundation/solana-developer-platform/compare/v0.18.1...v0.18.2) (2026-04-29)

### Bug Fixes

* **web:** keep wallet actions button on one line ([#238](https://github.com/solana-foundation/solana-developer-platform/pull/238)) ([18c9109](https://github.com/solana-foundation/solana-developer-platform/commit/18c9109ca73fa88d3073dabd5153680825d4fd44))

## [0.18.1](https://github.com/solana-foundation/solana-developer-platform/compare/v0.18.0...v0.18.1) (2026-04-29)

### Other Changes

* Fix docs dark mode tokens ([#236](https://github.com/solana-foundation/solana-developer-platform/pull/236)) ([40d23c7](https://github.com/solana-foundation/solana-developer-platform/commit/40d23c7c23d6ecd992ac2dea7831a00484dfb584))

## [0.18.0](https://github.com/solana-foundation/solana-developer-platform/compare/v0.17.3...v0.18.0) (2026-04-29)

### Features

* add devnet faucet wallet action ([#235](https://github.com/solana-foundation/solana-developer-platform/pull/235)) ([c23f5fe](https://github.com/solana-foundation/solana-developer-platform/commit/c23f5feda038e45bc69acc7dab345db6765edbd3))

### Documentation

* fix public API readiness references ([#233](https://github.com/solana-foundation/solana-developer-platform/pull/233)) ([e5b514c](https://github.com/solana-foundation/solana-developer-platform/commit/e5b514cf11cfb3e2c6b4e81b62cb1ff177721631))

## [0.17.3](https://github.com/solana-foundation/solana-developer-platform/compare/v0.17.2...v0.17.3) (2026-04-29)

### Documentation

* align docs with SDP launch styling ([#231](https://github.com/solana-foundation/solana-developer-platform/pull/231)) ([1030b4f](https://github.com/solana-foundation/solana-developer-platform/commit/1030b4f1c883ba71c1b849a07e19d813b6da7106))

## [0.17.2](https://github.com/solana-foundation/solana-developer-platform/compare/v0.17.1...v0.17.2) (2026-04-29)

### Bug Fixes

* refresh wallet provisioning modal ([#230](https://github.com/solana-foundation/solana-developer-platform/pull/230)) ([5913aea](https://github.com/solana-foundation/solana-developer-platform/commit/5913aeaa53f8c7508dfbe5b01f1be0aa3cb069a1))

### Documentation

* add provider onboarding guidelines ([#229](https://github.com/solana-foundation/solana-developer-platform/pull/229)) ([926fe02](https://github.com/solana-foundation/solana-developer-platform/commit/926fe02e45077bcfc91274fe16cf32a4ba6aa2d2))
* remove unfinished public wording ([#225](https://github.com/solana-foundation/solana-developer-platform/pull/225)) ([c3b1ea1](https://github.com/solana-foundation/solana-developer-platform/commit/c3b1ea1d7d7ea28db1fb2b28a6d95f2a3bfadd32))
* simplify README and public OpenAPI ([#223](https://github.com/solana-foundation/solana-developer-platform/pull/223)) ([2bc0bb9](https://github.com/solana-foundation/solana-developer-platform/commit/2bc0bb95532782e0b0bbad9bba2eb7779ac3c17b))

### Maintenance

* remove stale kv service wrapper ([#226](https://github.com/solana-foundation/solana-developer-platform/pull/226)) ([8e6e0bb](https://github.com/solana-foundation/solana-developer-platform/commit/8e6e0bbbf8319c3ca8cf0d0566d9a96e3e35dd5a))
* HOO-444 make providers optional for self hosted ([#228](https://github.com/solana-foundation/solana-developer-platform/pull/228)) ([e1af00f](https://github.com/solana-foundation/solana-developer-platform/commit/e1af00f3ec01fd2244e06b238988b6acd586d213))
* HOO-424 rewrite repo docs for open source launch ([#193](https://github.com/solana-foundation/solana-developer-platform/pull/193)) ([87c452a](https://github.com/solana-foundation/solana-developer-platform/commit/87c452a91faf5a1923fefd4525f675c0d4645042))
* remove stale web infra scaffolding ([a214f62](https://github.com/solana-foundation/solana-developer-platform/commit/a214f62cd027b99254d8e7ad49e2f5234d563d41))

## [0.17.1](https://github.com/solana-foundation/solana-developer-platform/compare/v0.17.0...v0.17.1) (2026-04-21)

### Other Changes

* Align API playground status badges ([#221](https://github.com/solana-foundation/solana-developer-platform/pull/221)) ([9c35c4e](https://github.com/solana-foundation/solana-developer-platform/commit/9c35c4ed247b978bb848aa1fedc2fcf70fcff114))

## [0.17.0](https://github.com/solana-foundation/solana-developer-platform/compare/v0.16.6...v0.17.0) (2026-04-21)

### Features

* **deps:** upgrade Clerk to v7 ([#219](https://github.com/solana-foundation/solana-developer-platform/pull/219)) ([b8d4913](https://github.com/solana-foundation/solana-developer-platform/commit/b8d4913c9d62d2ca2a2f54f25b43b14f26732517))

### Maintenance

* **deps:** bump the actions group with 4 updates ([#198](https://github.com/solana-foundation/solana-developer-platform/pull/198)) ([d531b70](https://github.com/solana-foundation/solana-developer-platform/commit/d531b70e45f2393cc53c6a77109d96988a96212e))

### Other Changes

* Remove vulnerable Vercel Toolbar dependency ([#220](https://github.com/solana-foundation/solana-developer-platform/pull/220)) ([2604490](https://github.com/solana-foundation/solana-developer-platform/commit/26044902ee5050c4c7baee4f3f58c13ea91eacef))

## [0.16.6](https://github.com/solana-foundation/solana-developer-platform/compare/v0.16.5...v0.16.6) (2026-04-20)

### Maintenance

* **deps:** bundle toolchain updates ([#216](https://github.com/solana-foundation/solana-developer-platform/pull/216)) ([fc0a4fe](https://github.com/solana-foundation/solana-developer-platform/commit/fc0a4fe01ac12a7d16ab475c67f734aa1966cd47))
* **deps:** bundle zod openapi updates ([#214](https://github.com/solana-foundation/solana-developer-platform/pull/214)) ([71e6b29](https://github.com/solana-foundation/solana-developer-platform/commit/71e6b297e9ef95fbba8578b984e5cb4872488ac0))

## [0.16.5](https://github.com/solana-foundation/solana-developer-platform/compare/v0.16.4...v0.16.5) (2026-04-20)

### Bug Fixes

* render Wrangler config from Doppler for API deploys ([#195](https://github.com/solana-foundation/solana-developer-platform/pull/195)) ([f0859b7](https://github.com/solana-foundation/solana-developer-platform/commit/f0859b7e4212b2ec809c316925a6ee07735dad45))

### Maintenance

* **deps:** bundle docs framework updates ([18df8a7](https://github.com/solana-foundation/solana-developer-platform/commit/18df8a71fb24d485112df800a41b3abdb993ac1f))
* **deps:** bundle easy dependabot updates ([#212](https://github.com/solana-foundation/solana-developer-platform/pull/212)) ([9b708eb](https://github.com/solana-foundation/solana-developer-platform/commit/9b708eb80e4e3e680575cd60eb25f50aa8b75cd0))
* HOO-421 add initial versions ([#190](https://github.com/solana-foundation/solana-developer-platform/pull/190)) ([0351e4a](https://github.com/solana-foundation/solana-developer-platform/commit/0351e4ae41d575b33cbd3c32081370ee7b64f2e5))

### Other Changes

* Add config for dependabot and separate actions for codeql and dependency review ([#187](https://github.com/solana-foundation/solana-developer-platform/pull/187)) ([a6f29f9](https://github.com/solana-foundation/solana-developer-platform/commit/a6f29f95f99d6c9f38677b0e2591b0fd7a878ba8))

## [0.16.4](https://github.com/solana-foundation/solana-developer-platform/compare/v0.16.3...v0.16.4) (2026-04-16)

### Bug Fixes

* **web:** make api key wallet modal scroll ([#191](https://github.com/solana-foundation/solana-developer-platform/pull/191)) ([e60ff1e](https://github.com/solana-foundation/solana-developer-platform/commit/e60ff1ee85e874f90b7b84ae19a3459ca274c448))

### Maintenance

* HOO-420 Sanitize tracked credentials and infra config ([#186](https://github.com/solana-foundation/solana-developer-platform/pull/186)) ([92dde21](https://github.com/solana-foundation/solana-developer-platform/commit/92dde21ef1a0a22f75ae873710f20aef7af9ee5f))

## [0.16.3](https://github.com/solana-foundation/solana-developer-platform/compare/v0.16.2...v0.16.3) (2026-04-14)

### Maintenance

* Remediate high severity dependency advisories ([#174](https://github.com/solana-foundation/solana-developer-platform/pull/174)) ([d986a6b](https://github.com/solana-foundation/solana-developer-platform/commit/d986a6b5ba8fd4b76b31bffede9019e943aa75c8))

## [0.16.2](https://github.com/solana-foundation/solana-developer-platform/compare/v0.16.1...v0.16.2) (2026-04-13)

### Bug Fixes

* add tos notice to auth pages ([#184](https://github.com/solana-foundation/solana-developer-platform/pull/184)) ([ff7d87f](https://github.com/solana-foundation/solana-developer-platform/commit/ff7d87f3e52b9a7483c626a3bb1696266fec3491))

## [0.16.1](https://github.com/solana-foundation/solana-developer-platform/compare/v0.16.0...v0.16.1) (2026-04-13)

### Other Changes

* default new organizations to enterprise tier ([#182](https://github.com/solana-foundation/solana-developer-platform/pull/182)) ([41662a3](https://github.com/solana-foundation/solana-developer-platform/commit/41662a34a8c7d707e6d42cd37ee749b301a6b14d))

## [0.16.0](https://github.com/solana-foundation/solana-developer-platform/compare/v0.15.2...v0.16.0) (2026-04-13)

### Features

* add issuance allowlist and denylist controls ([#179](https://github.com/solana-foundation/solana-developer-platform/pull/179)) ([8a8e16b](https://github.com/solana-foundation/solana-developer-platform/commit/8a8e16b2a539b7f22cb3ac6efac29057dc5a5f4b))

### Bug Fixes

* make homepage dashboard CTA sign in ([#181](https://github.com/solana-foundation/solana-developer-platform/pull/181)) ([8b61a97](https://github.com/solana-foundation/solana-developer-platform/commit/8b61a972e06696d0a204c22b79f9309f9f38dac0))
* **sdp-web:** restore landing sign-in button ([#173](https://github.com/solana-foundation/solana-developer-platform/pull/173)) ([98f4b15](https://github.com/solana-foundation/solana-developer-platform/commit/98f4b151b8235c790f309d20a9becb20b2e76ad8))

## [0.15.2](https://github.com/solana-foundation/solana-developer-platform/compare/v0.15.1...v0.15.2) (2026-04-13)

### Bug Fixes

* support configurable issuance token setup ([#177](https://github.com/solana-foundation/solana-developer-platform/pull/177)) ([21cc4ad](https://github.com/solana-foundation/solana-developer-platform/commit/21cc4ad3371f8478385a3b1b8eb240882cacb01a))

## [0.15.1](https://github.com/solana-foundation/solana-developer-platform/compare/v0.15.0...v0.15.1) (2026-04-13)

### Bug Fixes

* remove SOL balances from payments UI (PRO-1126) ([#175](https://github.com/solana-foundation/solana-developer-platform/pull/175)) ([93db592](https://github.com/solana-foundation/solana-developer-platform/commit/93db59259b7b909bb54c2ccf3cb314853445ac39))

## [0.15.0](https://github.com/solana-foundation/solana-developer-platform/compare/v0.14.7...v0.15.0) (2026-04-10)

### Features

* PRO-1085 sentry user feedback ([#159](https://github.com/solana-foundation/solana-developer-platform/pull/159)) ([5a5ce55](https://github.com/solana-foundation/solana-developer-platform/commit/5a5ce55071ee2b89b0fd09d79db085affdc9bcd0))
* **api:** sync Clerk organizations from webhooks ([#167](https://github.com/solana-foundation/solana-developer-platform/pull/167)) ([3932813](https://github.com/solana-foundation/solana-developer-platform/commit/3932813c2b79b63fd8e18eda812a4060e00ef14e))

### Bug Fixes

* **sdp-web:** restore dashboard button and feedback styling ([#172](https://github.com/solana-foundation/solana-developer-platform/pull/172)) ([c3babf8](https://github.com/solana-foundation/solana-developer-platform/commit/c3babf8a18f993b45cd5e0c881e776602666e1ee))
* show wallet deposits in recent transactions ([#170](https://github.com/solana-foundation/solana-developer-platform/pull/170)) ([5e40be9](https://github.com/solana-foundation/solana-developer-platform/commit/5e40be926a7fcf9ac53aaa441236ea2bd55a84fa))
* use pointer cursor for interactive controls ([#168](https://github.com/solana-foundation/solana-developer-platform/pull/168)) ([9a885c7](https://github.com/solana-foundation/solana-developer-platform/commit/9a885c7d7c0a9829942d4403172cd41e54bb7aff))

### Refactors

* **sdp-web:** migrate to Solana design system ([44b73c1](https://github.com/solana-foundation/solana-developer-platform/commit/44b73c18520dd373de21699c5cdd9cc663503015))

### Maintenance

* split integration tests ([a95bede](https://github.com/solana-foundation/solana-developer-platform/commit/a95bede09943f712f7c2c08d173dbe2c9f96a3df))

## [0.14.7](https://github.com/solana-foundation/solana-developer-platform/compare/v0.14.6...v0.14.7) (2026-04-10)

### Bug Fixes

* restore docs proxy origin ([#164](https://github.com/solana-foundation/solana-developer-platform/pull/164)) ([8e681e5](https://github.com/solana-foundation/solana-developer-platform/commit/8e681e595b9c2e0782d9d607a9f97d1da194bb58))

## [0.14.6](https://github.com/solana-foundation/solana-developer-platform/compare/v0.14.5...v0.14.6) (2026-04-10)

### Bug Fixes

* remove auth entry feature gates ([#162](https://github.com/solana-foundation/solana-developer-platform/pull/162)) ([54ad74e](https://github.com/solana-foundation/solana-developer-platform/commit/54ad74e82e3b8f2607c1d5f9d4d05c0e9970ba3d))

## [0.14.5](https://github.com/solana-foundation/solana-developer-platform/compare/v0.14.4...v0.14.5) (2026-04-09)

### Maintenance

* prepare webhook-only onboarding deploy cleanup ([c83883d](https://github.com/solana-foundation/solana-developer-platform/commit/c83883d87c2fd20095fc33166d1216adc1ebbe9d))
* adopt Doppler as SDP's secret source of truth ([58afe80](https://github.com/solana-foundation/solana-developer-platform/commit/58afe80fc0fab683f118cf767a2d20b53456fc1e))

## [0.14.4](https://github.com/solana-foundation/solana-developer-platform/compare/v0.14.3...v0.14.4) (2026-04-03)

### Refactors

* replace vendored cdp keychain with upstream package ([#154](https://github.com/solana-foundation/solana-developer-platform/pull/154)) ([f9b035e](https://github.com/solana-foundation/solana-developer-platform/commit/f9b035e24201c7122fe74c0bdf3d51517e148e4b))

## [0.14.3](https://github.com/solana-foundation/solana-developer-platform/compare/v0.14.2...v0.14.3) (2026-04-03)

### Refactors

* replace vendored para keychain with upstream package ([#153](https://github.com/solana-foundation/solana-developer-platform/pull/153)) ([0b878b3](https://github.com/solana-foundation/solana-developer-platform/commit/0b878b3d3e0182d868fba4d7ca585d3f52d50e60))

## [0.14.2](https://github.com/solana-foundation/solana-developer-platform/compare/v0.14.1...v0.14.2) (2026-04-03)

### Bug Fixes

* remove wallet faucet action from dashboard UI ([#151](https://github.com/solana-foundation/solana-developer-platform/pull/151)) ([bbc7013](https://github.com/solana-foundation/solana-developer-platform/commit/bbc7013999eec8257f5f7e96e00ae83f93587a32))

## [0.14.1](https://github.com/solana-foundation/solana-developer-platform/compare/v0.14.0...v0.14.1) (2026-04-03)

### Maintenance

* speed up browser e2e pipeline ([#149](https://github.com/solana-foundation/solana-developer-platform/pull/149)) ([978ed3b](https://github.com/solana-foundation/solana-developer-platform/commit/978ed3be40747301a90405338894ac4f53922982))

## [0.14.0](https://github.com/solana-foundation/solana-developer-platform/compare/v0.13.1...v0.14.0) (2026-04-03)

### Features

* add individual and enterprise provider tier gating ([#147](https://github.com/solana-foundation/solana-developer-platform/pull/147)) ([0c489a0](https://github.com/solana-foundation/solana-developer-platform/commit/0c489a00d0360a8025343b27489a52a3783a81d7))

## [0.13.1](https://github.com/solana-foundation/solana-developer-platform/compare/v0.13.0...v0.13.1) (2026-04-02)

### Maintenance

* template devnet rpc provider config ([#145](https://github.com/solana-foundation/solana-developer-platform/pull/145)) ([c6c1ea1](https://github.com/solana-foundation/solana-developer-platform/commit/c6c1ea1817b4a9b6cafe7da583d2084e0373b6a3))

## [0.13.0](https://github.com/solana-foundation/solana-developer-platform/compare/v0.12.0...v0.13.0) (2026-04-02)

### Features

* cut SDP over to Postgres and stabilize hidden auth entry rollout ([#143](https://github.com/solana-foundation/solana-developer-platform/pull/143)) ([f033fec](https://github.com/solana-foundation/solana-developer-platform/commit/f033fec630425cb495cdeaf884065e1a211d0da8))

## [0.12.0](https://github.com/solana-foundation/solana-developer-platform/compare/v0.11.1...v0.12.0) (2026-04-01)

### Features

* cut sdp-api over to Hyperdrive-backed Postgres ([#141](https://github.com/solana-foundation/solana-developer-platform/pull/141)) ([d78f50b](https://github.com/solana-foundation/solana-developer-platform/commit/d78f50b12afb1ca4b3c6789e71eb4386bf5d5a1c))

## [0.11.1](https://github.com/solana-foundation/solana-developer-platform/compare/v0.11.0...v0.11.1) (2026-03-25)

### Maintenance

* **web:** add local vercel toolbar support ([#139](https://github.com/solana-foundation/solana-developer-platform/pull/139)) ([efe6dc9](https://github.com/solana-foundation/solana-developer-platform/commit/efe6dc96621257ca0072c30316fc0aa19dd05d98))

## [0.11.0](https://github.com/solana-foundation/solana-developer-platform/compare/v0.10.3...v0.11.0) (2026-03-25)

### Features

* **web:** gate clerk auth entry with vercel flags ([#138](https://github.com/solana-foundation/solana-developer-platform/pull/138)) ([01527f4](https://github.com/solana-foundation/solana-developer-platform/commit/01527f4846c742dd1ec74840b04e2ba30973ba67))

### Bug Fixes

* **payments:** remove SOL from ramp asset options ([#136](https://github.com/solana-foundation/solana-developer-platform/pull/136)) ([9d8a948](https://github.com/solana-foundation/solana-developer-platform/commit/9d8a9481118e96ba4f003e6008361e6468e6adca))

## [0.10.3](https://github.com/solana-foundation/solana-developer-platform/compare/v0.10.2...v0.10.3) (2026-03-24)

### Bug Fixes

* point docs dashboard link to the SDP root ([#134](https://github.com/solana-foundation/solana-developer-platform/pull/134)) ([7427d38](https://github.com/solana-foundation/solana-developer-platform/commit/7427d38b1d70e48f1c4501d14fcb07e4100c59e7))

## [0.10.2](https://github.com/solana-foundation/solana-developer-platform/compare/v0.10.1...v0.10.2) (2026-03-23)

### Bug Fixes

* reuse Clerk auth work and move AI docs into /docs ([#132](https://github.com/solana-foundation/solana-developer-platform/pull/132)) ([0a8d4b1](https://github.com/solana-foundation/solana-developer-platform/commit/0a8d4b17dc94dcb471dea9cb10c6377feec16ef5))

## [0.10.1](https://github.com/solana-foundation/solana-developer-platform/compare/v0.10.0...v0.10.1) (2026-03-23)

### Bug Fixes

* configure git identity before publishing release tag ([#130](https://github.com/solana-foundation/solana-developer-platform/pull/130)) ([732b398](https://github.com/solana-foundation/solana-developer-platform/commit/732b39896ab0b1a5fd3a7c69bfb043754e2e33de))

## [0.10.0](https://github.com/solana-foundation/solana-developer-platform/compare/v0.9.0...v0.10.0) (2026-03-23)

### Features

* refresh landing hero copy ([#124](https://github.com/solana-foundation/solana-developer-platform/pull/124)) ([0527fa9](https://github.com/solana-foundation/solana-developer-platform/commit/0527fa98f3ac2f544a886e16d4b2c9057ee2544c))

### Bug Fixes

* preserve package formatting in release flow ([#129](https://github.com/solana-foundation/solana-developer-platform/pull/129)) ([efb8c8f](https://github.com/solana-foundation/solana-developer-platform/commit/efb8c8f75b3be6c2cea43f808148f5de47cffee0))
* handle non-captured git calls in release flow ([#127](https://github.com/solana-foundation/solana-developer-platform/pull/127)) ([7756c3a](https://github.com/solana-foundation/solana-developer-platform/commit/7756c3ac1d77c7a99ae5594e1db6f5c767ea3132))
* quote release workflow conditions ([#126](https://github.com/solana-foundation/solana-developer-platform/pull/126)) ([8762727](https://github.com/solana-foundation/solana-developer-platform/commit/8762727c8bb5aa36475e07ced53db25714119e2b))
* docs postman collection links ([#123](https://github.com/solana-foundation/solana-developer-platform/pull/123)) ([34805cc](https://github.com/solana-foundation/solana-developer-platform/commit/34805ccc8709c2a99ac2b4208a736c1b040cb283))

## [0.9.0](https://github.com/solana-foundation/solana-developer-platform/compare/v0.8.0...v0.9.0) (2026-03-23)


### Features

* add persisted dashboard cache layer ([#121](https://github.com/solana-foundation/solana-developer-platform/issues/121)) ([9c68328](https://github.com/solana-foundation/solana-developer-platform/commit/9c683282b84c5121d44be4c54a7edc8f9c436aba))

## [0.8.0](https://github.com/solana-foundation/solana-developer-platform/compare/v0.7.0...v0.8.0) (2026-03-23)


### Features

* simplify waitlist gate on landing page ([#119](https://github.com/solana-foundation/solana-developer-platform/issues/119)) ([5c5b9df](https://github.com/solana-foundation/solana-developer-platform/commit/5c5b9df3e9e62a054215c87dbda525c7b83beda3))

## [0.7.0](https://github.com/solana-foundation/solana-developer-platform/compare/v0.6.1...v0.7.0) (2026-03-23)


### Features

* add waitlist CTA to gated auth landing ([#117](https://github.com/solana-foundation/solana-developer-platform/issues/117)) ([78e0a3f](https://github.com/solana-foundation/solana-developer-platform/commit/78e0a3fc7a0413eb5fc8cd699e4304813935ced9))

## [0.6.1](https://github.com/solana-foundation/solana-developer-platform/compare/v0.6.0...v0.6.1) (2026-03-23)


### Bug Fixes

* gate production auth entry points ([#115](https://github.com/solana-foundation/solana-developer-platform/issues/115)) ([9473cb1](https://github.com/solana-foundation/solana-developer-platform/commit/9473cb134f7bbe441b5428fd134f33503bd899c0))

## [0.6.0](https://github.com/solana-foundation/solana-developer-platform/compare/v0.5.3...v0.6.0) (2026-03-22)


### Features

* **custody:** streamline Fireblocks platform flow ([#112](https://github.com/solana-foundation/solana-developer-platform/issues/112)) ([60ae76f](https://github.com/solana-foundation/solana-developer-platform/commit/60ae76f266802ac3d37ef838cc462848649de1d0))
* **docs:** add generated public Postman collection ([#111](https://github.com/solana-foundation/solana-developer-platform/issues/111)) ([7724d68](https://github.com/solana-foundation/solana-developer-platform/commit/7724d68c30e03f9b98192650b85ab09655004fa9))
* **observability:** add page and request timing traces ([#109](https://github.com/solana-foundation/solana-developer-platform/issues/109)) ([1f4d26d](https://github.com/solana-foundation/solana-developer-platform/commit/1f4d26d79e36c9691c989125e28a85c0307ac2f7))
* **payments:** improve dashboard balances and responsiveness ([#106](https://github.com/solana-foundation/solana-developer-platform/issues/106)) ([585af77](https://github.com/solana-foundation/solana-developer-platform/commit/585af775f5ff5e90e000ccb613e41a28acf9203b))
* **payments:** move send and receive into full-page flows ([#105](https://github.com/solana-foundation/solana-developer-platform/issues/105)) ([dd24953](https://github.com/solana-foundation/solana-developer-platform/commit/dd2495397cf2d737c38ea8e97ee3a050fe876a45))
* refine dashboard permissions, issuance UX, and wallet activity ([#113](https://github.com/solana-foundation/solana-developer-platform/issues/113)) ([a67019e](https://github.com/solana-foundation/solana-developer-platform/commit/a67019ec4d31c62d3e8423497f5b36a25d10e638))


### Bug Fixes

* **api:** prevent dev RPC config drift ([#101](https://github.com/solana-foundation/solana-developer-platform/issues/101)) ([f43ed93](https://github.com/solana-foundation/solana-developer-platform/commit/f43ed931dea99cd4531f1e1a9a76842d51dc23b8))
* **web:** improve token status and api key actions ([#104](https://github.com/solana-foundation/solana-developer-platform/issues/104)) ([d435cf4](https://github.com/solana-foundation/solana-developer-platform/commit/d435cf484c234837377ab93f5600905b9af47a03))


### Performance Improvements

* **dashboard:** defer heavy wallet and activity loads ([#110](https://github.com/solana-foundation/solana-developer-platform/issues/110)) ([87605b8](https://github.com/solana-foundation/solana-developer-platform/commit/87605b810aa6dc4d7a0905c5cd0d4cc51039a218))

## [0.5.3](https://github.com/solana-foundation/solana-developer-platform/compare/v0.5.2...v0.5.3) (2026-03-17)


### Bug Fixes

* **custody:** improve wallet and token management flows ([#96](https://github.com/solana-foundation/solana-developer-platform/issues/96)) ([66e2f8f](https://github.com/solana-foundation/solana-developer-platform/commit/66e2f8f7c1409c7bd46a748fe224d0c85c75acdf))

## [0.5.2](https://github.com/solana-foundation/solana-developer-platform/compare/v0.5.1...v0.5.2) (2026-03-14)


### Bug Fixes

* **wallets:** remove provider card descriptions ([#94](https://github.com/solana-foundation/solana-developer-platform/issues/94)) ([594e00e](https://github.com/solana-foundation/solana-developer-platform/commit/594e00e96573150beb32e635eb86b842e3236a9f))

## [0.5.1](https://github.com/solana-foundation/solana-developer-platform/compare/v0.5.0...v0.5.1) (2026-03-13)


### Bug Fixes

* **web:** route home wallet CTA to wallets ([#92](https://github.com/solana-foundation/solana-developer-platform/issues/92)) ([5e461d9](https://github.com/solana-foundation/solana-developer-platform/commit/5e461d980357bfa6ebb5268e5822be2808f4b100))

## [0.5.0](https://github.com/solana-foundation/solana-developer-platform/compare/v0.4.0...v0.5.0) (2026-03-13)


### Features

* **docs:** add ai discovery resources ([#85](https://github.com/solana-foundation/solana-developer-platform/issues/85)) ([b57bcf8](https://github.com/solana-foundation/solana-developer-platform/commit/b57bcf803662890e4c1b16b53957ecf55fc91f2f))
* **wallets:** redesign setup and management flows ([#89](https://github.com/solana-foundation/solana-developer-platform/issues/89)) ([2e0a309](https://github.com/solana-foundation/solana-developer-platform/commit/2e0a309d08a8b25141ec4f5619f8e6953b4cbf2f))


### Bug Fixes

* tolerate wallet balance RPC failures ([#91](https://github.com/solana-foundation/solana-developer-platform/issues/91)) ([6db468c](https://github.com/solana-foundation/solana-developer-platform/commit/6db468ceba7b76dcdcd7f077b8a0dcc294c47880))


### Performance Improvements

* improve dashboard load performance ([#90](https://github.com/solana-foundation/solana-developer-platform/issues/90)) ([33035a7](https://github.com/solana-foundation/solana-developer-platform/commit/33035a7243b0c9fb1e309afcc4f75ce8a81b3b1c))

## [0.4.0](https://github.com/solana-foundation/solana-developer-platform/compare/v0.3.0...v0.4.0) (2026-03-12)


### Features

* **api:** unify wallet-scoped authorization ([#81](https://github.com/solana-foundation/solana-developer-platform/issues/81)) ([63caac2](https://github.com/solana-foundation/solana-developer-platform/commit/63caac2313f4ec41f5efd7ee709846217d5b46d9))
* **dashboard:** redesign home summary ([#80](https://github.com/solana-foundation/solana-developer-platform/issues/80)) ([2d2533e](https://github.com/solana-foundation/solana-developer-platform/commit/2d2533e970cf834a693c3bfed78d2789cfde1e82))
* **docs:** add postman api key suite ([#82](https://github.com/solana-foundation/solana-developer-platform/issues/82)) ([eb3cebc](https://github.com/solana-foundation/solana-developer-platform/commit/eb3cebcdc297b55004f30b48452d0e74dcd7d6db))
* **issuance:** redesign token management workflow ([#84](https://github.com/solana-foundation/solana-developer-platform/issues/84)) ([3973bb8](https://github.com/solana-foundation/solana-developer-platform/commit/3973bb8a8df22924e5ae3911338a46a70ee54f02))
* **payments:** overhaul payments overview and ramp demos ([#78](https://github.com/solana-foundation/solana-developer-platform/issues/78)) ([c12efeb](https://github.com/solana-foundation/solana-developer-platform/commit/c12efeb9a2d7e7d70c04ef214e231c883b6404be))

## [0.3.0](https://github.com/solana-foundation/solana-developer-platform/compare/v0.2.0...v0.3.0) (2026-03-06)


### Features

* add custody config endpoints and storage ([2ef7571](https://github.com/solana-foundation/solana-developer-platform/commit/2ef75717bf3808cc5d8a49caf8747cba10b455f1))
* add historial transfers ([26785a5](https://github.com/solana-foundation/solana-developer-platform/commit/26785a558d11bafd47e79f0bfb03ea89838d9327))
* add Mosaic service helpers ([e7ad10a](https://github.com/solana-foundation/solana-developer-platform/commit/e7ad10ae9cc7b624f2aa9d52a4a0e9d739c60cb7))
* add org-level rpc provider settings and relay coverage ([dded1f5](https://github.com/solana-foundation/solana-developer-platform/commit/dded1f518479473a9206b09adeab601c0344feb9))
* align token templates with Mosaic ([1b0833b](https://github.com/solana-foundation/solana-developer-platform/commit/1b0833b79b5692600f93e910b5152006e752ea9f))
* **api:** add /webhooks/clerk/link-orgs alias ([#11](https://github.com/solana-foundation/solana-developer-platform/issues/11)) ([d81f256](https://github.com/solana-foundation/solana-developer-platform/commit/d81f25672c05207eed722f3259b276c68c0ac5b4))
* **api:** add BVNK ramps provider + hawk auth support ([#61](https://github.com/solana-foundation/solana-developer-platform/issues/61)) ([23216ec](https://github.com/solana-foundation/solana-developer-platform/commit/23216ec00764d432c526e4cc8eaa91e60380c7f8))
* **api:** add custody switch and default wallet endpoints ([04d0799](https://github.com/solana-foundation/solana-developer-platform/commit/04d079978cf395593331099023dd9303da14fbde))
* **api:** add privy signer support ([c723267](https://github.com/solana-foundation/solana-developer-platform/commit/c7232674082a47d3222d32268737494f71eb169a))
* **api:** add privy signing provider ([8d5b3f3](https://github.com/solana-foundation/solana-developer-platform/commit/8d5b3f395b934972a8b3f3fb1de56739d2142c5f))
* **api:** add project-aware RPC relay round-robin ([3c1ef36](https://github.com/solana-foundation/solana-developer-platform/commit/3c1ef368d5f37a5e609bcaf78157514e1144fcf4))
* **api:** add rpc relay round-robin with project provider preferences ([de9dbe9](https://github.com/solana-foundation/solana-developer-platform/commit/de9dbe99d4a07bbc7934730ccc416334a9331f77))
* **api:** draft payments openapi schema ([#8](https://github.com/solana-foundation/solana-developer-platform/issues/8)) ([eedf9d7](https://github.com/solana-foundation/solana-developer-platform/commit/eedf9d7ff3051eb24f182bfe7bb7143eb7ae0a4f))
* **api:** implement payments part 1 transfer endpoints and custody-aligned wallet controls ([1daf62f](https://github.com/solana-foundation/solana-developer-platform/commit/1daf62fbf98b6eb9fab7d69fd11e65e7ceca0496))
* **api:** privy reseller custody + api key wallet binding ([db8a8e3](https://github.com/solana-foundation/solana-developer-platform/commit/db8a8e3df70b79bc5c8eff449a0b04350fec8462))
* **api:** privy reseller custody + api-key scoped signing ([77e656c](https://github.com/solana-foundation/solana-developer-platform/commit/77e656c4f0724ac6edfa2819cdbc902bc9abeb29))
* **api:** provision custody on org create ([0fb58d3](https://github.com/solana-foundation/solana-developer-platform/commit/0fb58d313a6a2645b8456de0c675328cff6cae40))
* **api:** ship high-priority issuance and org hardening ([14a31fa](https://github.com/solana-foundation/solana-developer-platform/commit/14a31fa174d757e29b68c213f262ca801648ba2b))
* **api:** use api-key scoped signer for issuance ([da602fb](https://github.com/solana-foundation/solana-developer-platform/commit/da602fb4605b24cabd2bda5b782d5ffe53237248))
* **api:** wire coinbase CDP runtime signer via keychain adapter ([8812f3b](https://github.com/solana-foundation/solana-developer-platform/commit/8812f3be7a6b8d5651f508f095fa37293668da1d))
* **auth:** Clerk allowlist + org invites ([#10](https://github.com/solana-foundation/solana-developer-platform/issues/10)) ([5ad48b5](https://github.com/solana-foundation/solana-developer-platform/commit/5ad48b5c5ffeabe36e779ded388582b344811e35))
* **cdp:** add coinbase CDP custody provisioning integration ([135248d](https://github.com/solana-foundation/solana-developer-platform/commit/135248d098a64d4dfb0f39c5912bef25bad6c664))
* **cdp:** enable coinbase runtime signer and wallet check flow ([0d0969f](https://github.com/solana-foundation/solana-developer-platform/commit/0d0969fd7dc5ba83daf69d5d8e77ec570fbfdf21))
* **ci:** automate tagged production releases ([#73](https://github.com/solana-foundation/solana-developer-platform/issues/73)) ([91fcc24](https://github.com/solana-foundation/solana-developer-platform/commit/91fcc243c9f4bd260affc947ece954ed3a99e570))
* **compliance:** Compliance risk scores ([#58](https://github.com/solana-foundation/solana-developer-platform/issues/58)) ([89ccfaa](https://github.com/solana-foundation/solana-developer-platform/commit/89ccfaa9f788dcba0c273f1c5a94625b0ba94f5b))
* **custody:** add Para provider parity via internal keychain module ([#42](https://github.com/solana-foundation/solana-developer-platform/issues/42)) ([926ee1d](https://github.com/solana-foundation/solana-developer-platform/commit/926ee1d193f027e8b8a25972cc01a13323e0ef56))
* **custody:** add Turnkey provider and provider-switch wallet reuse UX ([#41](https://github.com/solana-foundation/solana-developer-platform/issues/41)) ([1c95362](https://github.com/solana-foundation/solana-developer-platform/commit/1c9536223edee06dbfa77d3bef0512e29cdc5ce1))
* **custody:** align fireblocks setup and switch provider flows ([dc627da](https://github.com/solana-foundation/solana-developer-platform/commit/dc627da0126b60d641e74f790fceb89d97024f67))
* **custody:** align Fireblocks setup and switch provider flows ([948fed6](https://github.com/solana-foundation/solana-developer-platform/commit/948fed68ff2ae81cecf23417cf1be497be2aeeb0))
* **custody:** support multi-provider signer and provider lifecycle wallets ([#62](https://github.com/solana-foundation/solana-developer-platform/issues/62)) ([851782f](https://github.com/solana-foundation/solana-developer-platform/commit/851782f67c85c76593ad9068abf6a85bba137e84))
* **custody:** web UI for provider + wallet management ([5537ce1](https://github.com/solana-foundation/solana-developer-platform/commit/5537ce1b71a1b311bb0fac3a30f90a3ca78e3dfd))
* docs ([#59](https://github.com/solana-foundation/solana-developer-platform/issues/59)) ([815491c](https://github.com/solana-foundation/solana-developer-platform/commit/815491c5e8ca3e6028c9d77bd229daa98bca6f7d))
* guide onboarding when issuance API key is invalid ([718793d](https://github.com/solana-foundation/solana-developer-platform/commit/718793dd4cfa0611b38381793316dddd9f4a99c4))
* implement RPC proxy path and QuickNode provider support ([3cecec8](https://github.com/solana-foundation/solana-developer-platform/commit/3cecec89e8fa6edac17171ac5bd7bdf8f18fa7f3))
* **issuance:** add reusable endpoint playground cards ([f8e7ad8](https://github.com/solana-foundation/solana-developer-platform/commit/f8e7ad8dc100a9808d40ba21f767bbc1508f9254))
* **issuance:** make playground endpoints collapsible ([0c6cb1a](https://github.com/solana-foundation/solana-developer-platform/commit/0c6cb1acc022f15e8f9ecf728a24b9e161616eb4))
* **keychain:** add coinbase cdp signer and auth helpers ([626e170](https://github.com/solana-foundation/solana-developer-platform/commit/626e170d3ae6a9d9de76ebabc6bec1639bdc1263))
* **keychain:** add coinbase cdp signer and auth helpers ([5409af5](https://github.com/solana-foundation/solana-developer-platform/commit/5409af59ed6d1d0ab306a797f7c90b69376d6ba3))
* **keychain:** add internal coinbase cdp signer package scaffold (temporary, upstream-targeted) ([ba0d2f7](https://github.com/solana-foundation/solana-developer-platform/commit/ba0d2f7f8ffbe37b19e88af8256aab11e5fadb54))
* move emails to React templates ([411e2fd](https://github.com/solana-foundation/solana-developer-platform/commit/411e2fd50823fa6f5c554c7f985d1a3f21393f32))
* overhaul dashboard workflows and clerk auth support ([be2529b](https://github.com/solana-foundation/solana-developer-platform/commit/be2529b3da526c65846f73dc83cc44ebae58e295))
* **payments:** integrate Lightspark Grid ramps ([#55](https://github.com/solana-foundation/solana-developer-platform/issues/55)) ([aa67b4d](https://github.com/solana-foundation/solana-developer-platform/commit/aa67b4dbb0c09c873cedabcf72d9bec7e0f7d187))
* **payments:** remove ramp quotes and add MoonPay execute flows ([de2f340](https://github.com/solana-foundation/solana-developer-platform/commit/de2f34020e2cfaf8fa7182f74331df6ea8377e19))
* **payments:** remove ramp quotes and add MoonPay executes ([7eba69d](https://github.com/solana-foundation/solana-developer-platform/commit/7eba69d77b6d18ea4a8385828d11eea5eb6ce104))
* **payments:** wire dashboard payments UI and allow Clerk JWT auth ([#57](https://github.com/solana-foundation/solana-developer-platform/issues/57)) ([d617b36](https://github.com/solana-foundation/solana-developer-platform/commit/d617b365ab2a45593a3ec4ad54e26e1f64c08814))
* **playground:** attach selected api key secret for real execution ([a379b10](https://github.com/solana-foundation/solana-developer-platform/commit/a379b108e049a6abfd6b49e737c14ea79dc3cd8a))
* scaffold issuance dashboard phase one ([78defbb](https://github.com/solana-foundation/solana-developer-platform/commit/78defbbeb5e2c6024b7eaef881a0192e08b4d5fe))
* **sdp-web:** refactor create token modal flow (PRO-868) ([ed4d501](https://github.com/solana-foundation/solana-developer-platform/commit/ed4d501bef8dd441cc7770c01041078315ccc707))
* switch signing adapters to solana keychain ([0bae05d](https://github.com/solana-foundation/solana-developer-platform/commit/0bae05ddce083a9d0893a1db22050f1e0684b8fa))
* **web:** add custody setup and provider switch pages ([2170086](https://github.com/solana-foundation/solana-developer-platform/commit/21700861d4fa0c4689a5273bc904f0b10fe70a48))


### Bug Fixes

* add issuance transaction history and idempotency parity ([d160379](https://github.com/solana-foundation/solana-developer-platform/commit/d160379ce293a65a0fd1defe351ce0e0b3f44d44))
* address custody review regressions ([4098761](https://github.com/solana-foundation/solana-developer-platform/commit/40987612b4c33f79a53f6dad3f0db19734cf3faa))
* **api:** close custody/openapi merge blockers ([8f87e2e](https://github.com/solana-foundation/solana-developer-platform/commit/8f87e2ef91959b5769797b77b193b910c8eefebe))
* **api:** handle Coinbase account already_exists and scope account names ([#40](https://github.com/solana-foundation/solana-developer-platform/issues/40)) ([f684970](https://github.com/solana-foundation/solana-developer-platform/commit/f684970e99bd65ad5401ab8ea5580829f8e6f22e))
* **api:** honor project rpc settings in relay target resolution ([d6dc869](https://github.com/solana-foundation/solana-developer-platform/commit/d6dc869964307e3d77136bf078fba1cc8dbb7af3))
* **api:** use org-aware rpc target for wallet signer check ([#39](https://github.com/solana-foundation/solana-developer-platform/issues/39)) ([bf8c330](https://github.com/solana-foundation/solana-developer-platform/commit/bf8c330226e42f83cf9fe833358468c35748a440))
* **auth:** stabilize Clerk token usage in issuance page ([bd3cd09](https://github.com/solana-foundation/solana-developer-platform/commit/bd3cd09dacd56e0c5a4b50aa99c478d4079557e0))
* **ci:** align release tags with production deploys ([#75](https://github.com/solana-foundation/solana-developer-platform/issues/75)) ([d80c444](https://github.com/solana-foundation/solana-developer-platform/commit/d80c4446b05a6a109daa6ae63106b0f093c6ef39))
* **ci:** build keychain-coinbase before integration tests ([7a255a7](https://github.com/solana-foundation/solana-developer-platform/commit/7a255a77c8c7269057e7aff419967d197280942f))
* **ci:** emit keychain-coinbase build artifacts and normalize formatting ([521ab4a](https://github.com/solana-foundation/solana-developer-platform/commit/521ab4a0684bce9c14e46e98d2b3cbfc38fab6e6))
* **ci:** gate mosaic fee sponsorship on explicit kora env ([2673240](https://github.com/solana-foundation/solana-developer-platform/commit/26732400b30d93190ce86c6c465f7762a8fe0720))
* **ci:** resolve lint and transaction binding regressions ([7dbb653](https://github.com/solana-foundation/solana-developer-platform/commit/7dbb6537e91a19933cceedce2df3efdca3cfe79b))
* **custody:** require fireblocks credentials in setup flow ([d074476](https://github.com/solana-foundation/solana-developer-platform/commit/d074476590641d9a3cc23eba8f62e7c1d68c91f3))
* **custody:** support Clerk auth and onboarding gating ([e70dc01](https://github.com/solana-foundation/solana-developer-platform/commit/e70dc01a97deb450fb016cc0ad73b328d7202faf))
* export new issuance OpenAPI schema symbols ([7f124ef](https://github.com/solana-foundation/solana-developer-platform/commit/7f124ef61071b1180f7342e1425793f11cdfea2f))
* harden signing and Mosaic mint/freeze ([aca581c](https://github.com/solana-foundation/solana-developer-platform/commit/aca581cf4ca75b26df66665e54ea201c1700839a))
* high-priority API reliability fixes ([bc2b538](https://github.com/solana-foundation/solana-developer-platform/commit/bc2b538b96a9f6a7c253be2b0f74b59ea5b9a5bd))
* **issuance:** correct prepare transaction persistence ([4151c79](https://github.com/solana-foundation/solana-developer-platform/commit/4151c79d106def69ae25fa246851f1cb878e33ab))
* **issuance:** resolve malformed function declarations ([bdeb294](https://github.com/solana-foundation/solana-developer-platform/commit/bdeb294d47b48235f171b62d34d8c32caa19093f))
* **kora:** retry signAndSend on blockhash not found ([dced38e](https://github.com/solana-foundation/solana-developer-platform/commit/dced38ef301c50a5650e35a87adb46a4b4c52047))
* **kora:** stabilize devnet integration blockhash flake ([06fffd9](https://github.com/solana-foundation/solana-developer-platform/commit/06fffd94983c160dfee5281df156cb657c885752))
* **lint:** sort wallets custody imports ([d5420d2](https://github.com/solana-foundation/solana-developer-platform/commit/d5420d258e883ca7e571131a35af8bd19bd14803))
* normalize custody wallet creation errors ([a0c4840](https://github.com/solana-foundation/solana-developer-platform/commit/a0c48406b38f26ba18084afce61b222bdb95bedf))
* normalize custody wallet creation errors ([5b6c846](https://github.com/solana-foundation/solana-developer-platform/commit/5b6c8465d7127e6aaa71cad3a39a90a118ca5d53))
* **payments:** enforce wallet policies on transfers ([749f875](https://github.com/solana-foundation/solana-developer-platform/commit/749f875c03f530d70cd3f10523849154dcd81b71))
* **payments:** route SOL transfer signing through Kora when configured ([0199866](https://github.com/solana-foundation/solana-developer-platform/commit/01998660563643344413e2b89e51ad9bb3c40961))
* **playground:** auto-execute with selected key or session fallback ([72a76c8](https://github.com/solana-foundation/solana-developer-platform/commit/72a76c8c9cd49f6794ebea5fb723166f20da3b8b))
* **playground:** clarify missing secret vs missing key selection ([351b898](https://github.com/solana-foundation/solana-developer-platform/commit/351b8984d28f612c5b662ffc58a9b835128c355b))
* **playground:** fallback to browser origin when api base env is unset ([b45a75b](https://github.com/solana-foundation/solana-developer-platform/commit/b45a75b2791f97b524d39d4c82c2e81fa81f2912))
* **playground:** normalize pasted bearer token and validate api key format ([572ebb6](https://github.com/solana-foundation/solana-developer-platform/commit/572ebb6a6c6086763f5c66ba00d9a9a5e9a5fcd5))
* **playground:** use server api base url for endpoint execution ([473f041](https://github.com/solana-foundation/solana-developer-platform/commit/473f0414c8b31b59d97970297601ed7c8da9848a))
* remove duplicate token transaction response import ([b13bd86](https://github.com/solana-foundation/solana-developer-platform/commit/b13bd86f3cf76fac439ec54898353c06db7654b1))
* resolve biome lint issues ([d546dba](https://github.com/solana-foundation/solana-developer-platform/commit/d546dba0a898fa246e932908f37f5d3a9d7ededf))
* **rpc:** unblock settings test and set triton endpoint ([c986ceb](https://github.com/solana-foundation/solana-developer-platform/commit/c986ceb2643267476848f6f684bba5e4a09e00fa))
* satisfy biome formatter for revokeApiKey signature ([ed0af2c](https://github.com/solana-foundation/solana-developer-platform/commit/ed0af2cda8f8628e1c4eaa027d27acdd09612935))
* **web:** move api key focus handler to client component ([dd81d16](https://github.com/solana-foundation/solana-developer-platform/commit/dd81d162293b8f5af1f72549de7510dce4d94fbc))
* **web:** route RPC settings test through playground proxy ([7d8f7ec](https://github.com/solana-foundation/solana-developer-platform/commit/7d8f7ec9319dda4e8efaae3d77c5d0286ef3477f))


### Performance Improvements

* **wallets:** stream sections with local skeletons and faster entry ([6f4301b](https://github.com/solana-foundation/solana-developer-platform/commit/6f4301b984e79722a15e97547d7e04e8c9ada406))

## [0.2.0](https://github.com/solana-foundation/solana-developer-platform/compare/solana-developer-platform-v0.1.0...solana-developer-platform-v0.2.0) (2026-03-06)


### Features

* add custody config endpoints and storage ([2ef7571](https://github.com/solana-foundation/solana-developer-platform/commit/2ef75717bf3808cc5d8a49caf8747cba10b455f1))
* add historial transfers ([26785a5](https://github.com/solana-foundation/solana-developer-platform/commit/26785a558d11bafd47e79f0bfb03ea89838d9327))
* add Mosaic service helpers ([e7ad10a](https://github.com/solana-foundation/solana-developer-platform/commit/e7ad10ae9cc7b624f2aa9d52a4a0e9d739c60cb7))
* add org-level rpc provider settings and relay coverage ([dded1f5](https://github.com/solana-foundation/solana-developer-platform/commit/dded1f518479473a9206b09adeab601c0344feb9))
* align token templates with Mosaic ([1b0833b](https://github.com/solana-foundation/solana-developer-platform/commit/1b0833b79b5692600f93e910b5152006e752ea9f))
* **api:** add /webhooks/clerk/link-orgs alias ([#11](https://github.com/solana-foundation/solana-developer-platform/issues/11)) ([d81f256](https://github.com/solana-foundation/solana-developer-platform/commit/d81f25672c05207eed722f3259b276c68c0ac5b4))
* **api:** add BVNK ramps provider + hawk auth support ([#61](https://github.com/solana-foundation/solana-developer-platform/issues/61)) ([23216ec](https://github.com/solana-foundation/solana-developer-platform/commit/23216ec00764d432c526e4cc8eaa91e60380c7f8))
* **api:** add custody switch and default wallet endpoints ([04d0799](https://github.com/solana-foundation/solana-developer-platform/commit/04d079978cf395593331099023dd9303da14fbde))
* **api:** add privy signer support ([c723267](https://github.com/solana-foundation/solana-developer-platform/commit/c7232674082a47d3222d32268737494f71eb169a))
* **api:** add privy signing provider ([8d5b3f3](https://github.com/solana-foundation/solana-developer-platform/commit/8d5b3f395b934972a8b3f3fb1de56739d2142c5f))
* **api:** add project-aware RPC relay round-robin ([3c1ef36](https://github.com/solana-foundation/solana-developer-platform/commit/3c1ef368d5f37a5e609bcaf78157514e1144fcf4))
* **api:** add rpc relay round-robin with project provider preferences ([de9dbe9](https://github.com/solana-foundation/solana-developer-platform/commit/de9dbe99d4a07bbc7934730ccc416334a9331f77))
* **api:** draft payments openapi schema ([#8](https://github.com/solana-foundation/solana-developer-platform/issues/8)) ([eedf9d7](https://github.com/solana-foundation/solana-developer-platform/commit/eedf9d7ff3051eb24f182bfe7bb7143eb7ae0a4f))
* **api:** implement payments part 1 transfer endpoints and custody-aligned wallet controls ([1daf62f](https://github.com/solana-foundation/solana-developer-platform/commit/1daf62fbf98b6eb9fab7d69fd11e65e7ceca0496))
* **api:** privy reseller custody + api key wallet binding ([db8a8e3](https://github.com/solana-foundation/solana-developer-platform/commit/db8a8e3df70b79bc5c8eff449a0b04350fec8462))
* **api:** privy reseller custody + api-key scoped signing ([77e656c](https://github.com/solana-foundation/solana-developer-platform/commit/77e656c4f0724ac6edfa2819cdbc902bc9abeb29))
* **api:** provision custody on org create ([0fb58d3](https://github.com/solana-foundation/solana-developer-platform/commit/0fb58d313a6a2645b8456de0c675328cff6cae40))
* **api:** ship high-priority issuance and org hardening ([14a31fa](https://github.com/solana-foundation/solana-developer-platform/commit/14a31fa174d757e29b68c213f262ca801648ba2b))
* **api:** use api-key scoped signer for issuance ([da602fb](https://github.com/solana-foundation/solana-developer-platform/commit/da602fb4605b24cabd2bda5b782d5ffe53237248))
* **api:** wire coinbase CDP runtime signer via keychain adapter ([8812f3b](https://github.com/solana-foundation/solana-developer-platform/commit/8812f3be7a6b8d5651f508f095fa37293668da1d))
* **auth:** Clerk allowlist + org invites ([#10](https://github.com/solana-foundation/solana-developer-platform/issues/10)) ([5ad48b5](https://github.com/solana-foundation/solana-developer-platform/commit/5ad48b5c5ffeabe36e779ded388582b344811e35))
* **cdp:** add coinbase CDP custody provisioning integration ([135248d](https://github.com/solana-foundation/solana-developer-platform/commit/135248d098a64d4dfb0f39c5912bef25bad6c664))
* **cdp:** enable coinbase runtime signer and wallet check flow ([0d0969f](https://github.com/solana-foundation/solana-developer-platform/commit/0d0969fd7dc5ba83daf69d5d8e77ec570fbfdf21))
* **ci:** automate tagged production releases ([#73](https://github.com/solana-foundation/solana-developer-platform/issues/73)) ([91fcc24](https://github.com/solana-foundation/solana-developer-platform/commit/91fcc243c9f4bd260affc947ece954ed3a99e570))
* **compliance:** Compliance risk scores ([#58](https://github.com/solana-foundation/solana-developer-platform/issues/58)) ([89ccfaa](https://github.com/solana-foundation/solana-developer-platform/commit/89ccfaa9f788dcba0c273f1c5a94625b0ba94f5b))
* **custody:** add Para provider parity via internal keychain module ([#42](https://github.com/solana-foundation/solana-developer-platform/issues/42)) ([926ee1d](https://github.com/solana-foundation/solana-developer-platform/commit/926ee1d193f027e8b8a25972cc01a13323e0ef56))
* **custody:** add Turnkey provider and provider-switch wallet reuse UX ([#41](https://github.com/solana-foundation/solana-developer-platform/issues/41)) ([1c95362](https://github.com/solana-foundation/solana-developer-platform/commit/1c9536223edee06dbfa77d3bef0512e29cdc5ce1))
* **custody:** align fireblocks setup and switch provider flows ([dc627da](https://github.com/solana-foundation/solana-developer-platform/commit/dc627da0126b60d641e74f790fceb89d97024f67))
* **custody:** align Fireblocks setup and switch provider flows ([948fed6](https://github.com/solana-foundation/solana-developer-platform/commit/948fed68ff2ae81cecf23417cf1be497be2aeeb0))
* **custody:** support multi-provider signer and provider lifecycle wallets ([#62](https://github.com/solana-foundation/solana-developer-platform/issues/62)) ([851782f](https://github.com/solana-foundation/solana-developer-platform/commit/851782f67c85c76593ad9068abf6a85bba137e84))
* **custody:** web UI for provider + wallet management ([5537ce1](https://github.com/solana-foundation/solana-developer-platform/commit/5537ce1b71a1b311bb0fac3a30f90a3ca78e3dfd))
* docs ([#59](https://github.com/solana-foundation/solana-developer-platform/issues/59)) ([815491c](https://github.com/solana-foundation/solana-developer-platform/commit/815491c5e8ca3e6028c9d77bd229daa98bca6f7d))
* guide onboarding when issuance API key is invalid ([718793d](https://github.com/solana-foundation/solana-developer-platform/commit/718793dd4cfa0611b38381793316dddd9f4a99c4))
* implement RPC proxy path and QuickNode provider support ([3cecec8](https://github.com/solana-foundation/solana-developer-platform/commit/3cecec89e8fa6edac17171ac5bd7bdf8f18fa7f3))
* **issuance:** add reusable endpoint playground cards ([f8e7ad8](https://github.com/solana-foundation/solana-developer-platform/commit/f8e7ad8dc100a9808d40ba21f767bbc1508f9254))
* **issuance:** make playground endpoints collapsible ([0c6cb1a](https://github.com/solana-foundation/solana-developer-platform/commit/0c6cb1acc022f15e8f9ecf728a24b9e161616eb4))
* **keychain:** add coinbase cdp signer and auth helpers ([626e170](https://github.com/solana-foundation/solana-developer-platform/commit/626e170d3ae6a9d9de76ebabc6bec1639bdc1263))
* **keychain:** add coinbase cdp signer and auth helpers ([5409af5](https://github.com/solana-foundation/solana-developer-platform/commit/5409af59ed6d1d0ab306a797f7c90b69376d6ba3))
* **keychain:** add internal coinbase cdp signer package scaffold (temporary, upstream-targeted) ([ba0d2f7](https://github.com/solana-foundation/solana-developer-platform/commit/ba0d2f7f8ffbe37b19e88af8256aab11e5fadb54))
* move emails to React templates ([411e2fd](https://github.com/solana-foundation/solana-developer-platform/commit/411e2fd50823fa6f5c554c7f985d1a3f21393f32))
* overhaul dashboard workflows and clerk auth support ([be2529b](https://github.com/solana-foundation/solana-developer-platform/commit/be2529b3da526c65846f73dc83cc44ebae58e295))
* **payments:** integrate Lightspark Grid ramps ([#55](https://github.com/solana-foundation/solana-developer-platform/issues/55)) ([aa67b4d](https://github.com/solana-foundation/solana-developer-platform/commit/aa67b4dbb0c09c873cedabcf72d9bec7e0f7d187))
* **payments:** remove ramp quotes and add MoonPay execute flows ([de2f340](https://github.com/solana-foundation/solana-developer-platform/commit/de2f34020e2cfaf8fa7182f74331df6ea8377e19))
* **payments:** remove ramp quotes and add MoonPay executes ([7eba69d](https://github.com/solana-foundation/solana-developer-platform/commit/7eba69d77b6d18ea4a8385828d11eea5eb6ce104))
* **payments:** wire dashboard payments UI and allow Clerk JWT auth ([#57](https://github.com/solana-foundation/solana-developer-platform/issues/57)) ([d617b36](https://github.com/solana-foundation/solana-developer-platform/commit/d617b365ab2a45593a3ec4ad54e26e1f64c08814))
* **playground:** attach selected api key secret for real execution ([a379b10](https://github.com/solana-foundation/solana-developer-platform/commit/a379b108e049a6abfd6b49e737c14ea79dc3cd8a))
* scaffold issuance dashboard phase one ([78defbb](https://github.com/solana-foundation/solana-developer-platform/commit/78defbbeb5e2c6024b7eaef881a0192e08b4d5fe))
* **sdp-web:** refactor create token modal flow (PRO-868) ([ed4d501](https://github.com/solana-foundation/solana-developer-platform/commit/ed4d501bef8dd441cc7770c01041078315ccc707))
* switch signing adapters to solana keychain ([0bae05d](https://github.com/solana-foundation/solana-developer-platform/commit/0bae05ddce083a9d0893a1db22050f1e0684b8fa))
* **web:** add custody setup and provider switch pages ([2170086](https://github.com/solana-foundation/solana-developer-platform/commit/21700861d4fa0c4689a5273bc904f0b10fe70a48))


### Bug Fixes

* add issuance transaction history and idempotency parity ([d160379](https://github.com/solana-foundation/solana-developer-platform/commit/d160379ce293a65a0fd1defe351ce0e0b3f44d44))
* address custody review regressions ([4098761](https://github.com/solana-foundation/solana-developer-platform/commit/40987612b4c33f79a53f6dad3f0db19734cf3faa))
* **api:** close custody/openapi merge blockers ([8f87e2e](https://github.com/solana-foundation/solana-developer-platform/commit/8f87e2ef91959b5769797b77b193b910c8eefebe))
* **api:** handle Coinbase account already_exists and scope account names ([#40](https://github.com/solana-foundation/solana-developer-platform/issues/40)) ([f684970](https://github.com/solana-foundation/solana-developer-platform/commit/f684970e99bd65ad5401ab8ea5580829f8e6f22e))
* **api:** honor project rpc settings in relay target resolution ([d6dc869](https://github.com/solana-foundation/solana-developer-platform/commit/d6dc869964307e3d77136bf078fba1cc8dbb7af3))
* **api:** use org-aware rpc target for wallet signer check ([#39](https://github.com/solana-foundation/solana-developer-platform/issues/39)) ([bf8c330](https://github.com/solana-foundation/solana-developer-platform/commit/bf8c330226e42f83cf9fe833358468c35748a440))
* **auth:** stabilize Clerk token usage in issuance page ([bd3cd09](https://github.com/solana-foundation/solana-developer-platform/commit/bd3cd09dacd56e0c5a4b50aa99c478d4079557e0))
* **ci:** build keychain-coinbase before integration tests ([7a255a7](https://github.com/solana-foundation/solana-developer-platform/commit/7a255a77c8c7269057e7aff419967d197280942f))
* **ci:** emit keychain-coinbase build artifacts and normalize formatting ([521ab4a](https://github.com/solana-foundation/solana-developer-platform/commit/521ab4a0684bce9c14e46e98d2b3cbfc38fab6e6))
* **ci:** gate mosaic fee sponsorship on explicit kora env ([2673240](https://github.com/solana-foundation/solana-developer-platform/commit/26732400b30d93190ce86c6c465f7762a8fe0720))
* **ci:** resolve lint and transaction binding regressions ([7dbb653](https://github.com/solana-foundation/solana-developer-platform/commit/7dbb6537e91a19933cceedce2df3efdca3cfe79b))
* **custody:** require fireblocks credentials in setup flow ([d074476](https://github.com/solana-foundation/solana-developer-platform/commit/d074476590641d9a3cc23eba8f62e7c1d68c91f3))
* **custody:** support Clerk auth and onboarding gating ([e70dc01](https://github.com/solana-foundation/solana-developer-platform/commit/e70dc01a97deb450fb016cc0ad73b328d7202faf))
* export new issuance OpenAPI schema symbols ([7f124ef](https://github.com/solana-foundation/solana-developer-platform/commit/7f124ef61071b1180f7342e1425793f11cdfea2f))
* harden signing and Mosaic mint/freeze ([aca581c](https://github.com/solana-foundation/solana-developer-platform/commit/aca581cf4ca75b26df66665e54ea201c1700839a))
* high-priority API reliability fixes ([bc2b538](https://github.com/solana-foundation/solana-developer-platform/commit/bc2b538b96a9f6a7c253be2b0f74b59ea5b9a5bd))
* **issuance:** correct prepare transaction persistence ([4151c79](https://github.com/solana-foundation/solana-developer-platform/commit/4151c79d106def69ae25fa246851f1cb878e33ab))
* **issuance:** resolve malformed function declarations ([bdeb294](https://github.com/solana-foundation/solana-developer-platform/commit/bdeb294d47b48235f171b62d34d8c32caa19093f))
* **kora:** retry signAndSend on blockhash not found ([dced38e](https://github.com/solana-foundation/solana-developer-platform/commit/dced38ef301c50a5650e35a87adb46a4b4c52047))
* **kora:** stabilize devnet integration blockhash flake ([06fffd9](https://github.com/solana-foundation/solana-developer-platform/commit/06fffd94983c160dfee5281df156cb657c885752))
* **lint:** sort wallets custody imports ([d5420d2](https://github.com/solana-foundation/solana-developer-platform/commit/d5420d258e883ca7e571131a35af8bd19bd14803))
* normalize custody wallet creation errors ([a0c4840](https://github.com/solana-foundation/solana-developer-platform/commit/a0c48406b38f26ba18084afce61b222bdb95bedf))
* normalize custody wallet creation errors ([5b6c846](https://github.com/solana-foundation/solana-developer-platform/commit/5b6c8465d7127e6aaa71cad3a39a90a118ca5d53))
* **payments:** enforce wallet policies on transfers ([749f875](https://github.com/solana-foundation/solana-developer-platform/commit/749f875c03f530d70cd3f10523849154dcd81b71))
* **payments:** route SOL transfer signing through Kora when configured ([0199866](https://github.com/solana-foundation/solana-developer-platform/commit/01998660563643344413e2b89e51ad9bb3c40961))
* **playground:** auto-execute with selected key or session fallback ([72a76c8](https://github.com/solana-foundation/solana-developer-platform/commit/72a76c8c9cd49f6794ebea5fb723166f20da3b8b))
* **playground:** clarify missing secret vs missing key selection ([351b898](https://github.com/solana-foundation/solana-developer-platform/commit/351b8984d28f612c5b662ffc58a9b835128c355b))
* **playground:** fallback to browser origin when api base env is unset ([b45a75b](https://github.com/solana-foundation/solana-developer-platform/commit/b45a75b2791f97b524d39d4c82c2e81fa81f2912))
* **playground:** normalize pasted bearer token and validate api key format ([572ebb6](https://github.com/solana-foundation/solana-developer-platform/commit/572ebb6a6c6086763f5c66ba00d9a9a5e9a5fcd5))
* **playground:** use server api base url for endpoint execution ([473f041](https://github.com/solana-foundation/solana-developer-platform/commit/473f0414c8b31b59d97970297601ed7c8da9848a))
* remove duplicate token transaction response import ([b13bd86](https://github.com/solana-foundation/solana-developer-platform/commit/b13bd86f3cf76fac439ec54898353c06db7654b1))
* resolve biome lint issues ([d546dba](https://github.com/solana-foundation/solana-developer-platform/commit/d546dba0a898fa246e932908f37f5d3a9d7ededf))
* **rpc:** unblock settings test and set triton endpoint ([c986ceb](https://github.com/solana-foundation/solana-developer-platform/commit/c986ceb2643267476848f6f684bba5e4a09e00fa))
* satisfy biome formatter for revokeApiKey signature ([ed0af2c](https://github.com/solana-foundation/solana-developer-platform/commit/ed0af2cda8f8628e1c4eaa027d27acdd09612935))
* **web:** move api key focus handler to client component ([dd81d16](https://github.com/solana-foundation/solana-developer-platform/commit/dd81d162293b8f5af1f72549de7510dce4d94fbc))
* **web:** route RPC settings test through playground proxy ([7d8f7ec](https://github.com/solana-foundation/solana-developer-platform/commit/7d8f7ec9319dda4e8efaae3d77c5d0286ef3477f))


### Performance Improvements

* **wallets:** stream sections with local skeletons and faster entry ([6f4301b](https://github.com/solana-foundation/solana-developer-platform/commit/6f4301b984e79722a15e97547d7e04e8c9ada406))
