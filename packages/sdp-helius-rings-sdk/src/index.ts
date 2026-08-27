/**
 * The package's Kit-neutral surface, and deliberately the whole of it: its only
 * consumer is `@sdp/api` on Kit 6, where this package's Kit 7 brands can
 * structurally match the wrong major's type without any error.
 */
export { createRingsGateway, type RingsGatewayConfig } from "./gateway.js";
