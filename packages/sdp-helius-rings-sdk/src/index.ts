/**
 * The package's Kit-neutral surface, and deliberately the whole of it.
 *
 * Everything else here is typed in `@solana/kit` 7 and Zolana terms. The only
 * consumer is `@sdp/api`, which is on Kit 6, where those brands are not
 * assignable and, worse, can structurally match the wrong major's type without
 * any error. So the barrel exports one factory that takes plain string DTOs and
 * returns a port whose types all come from the Kit-free `@sdp/helius-rings`.
 * Widening this file with branded SDK types re-opens the hole.
 */
export { createRingsGateway, type RingsGatewayConfig } from "./gateway.js";
