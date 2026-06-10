# Changelog

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
