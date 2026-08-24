/**
 * The package's Kit-neutral surface, and deliberately the whole of it.
 *
 * Everything else here is typed in `@solana/kit` 7 and zolana terms —
 * `ShieldedMaterial` carries a `ViewingKey`, `createRingsClient` returns a
 * `ZolanaClient`, `CustodyWalletAuthority.solanaPublicKey()` returns a branded
 * `Address`. The only consumer is `@sdp/api`, which is on Kit 6, where those
 * brands are not assignable and, worse, can structurally match the wrong
 * major's type without any error. So the barrel exports one factory and its
 * config type, taking plain strings and returning a port whose types all come
 * from the Kit-free `@sdp/helius-rings`. Anything inside this package reaches
 * its siblings by
 * relative import; widening this file re-opens the hole.
 */
export { createRingsGateway, type RingsGatewayConfig } from "./gateway.js";
