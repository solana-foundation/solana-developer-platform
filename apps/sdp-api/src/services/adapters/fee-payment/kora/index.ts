/**
 * Kora Fee Payment Adapter
 *
 * Exports the Kora adapter for gasless transaction fee payment.
 */

export { KoraAdapter } from "./kora.adapter";
export { KoraClient, KoraClientError, type KoraErrorCode } from "./client";
export type { KoraAdapterConfig } from "./types";
