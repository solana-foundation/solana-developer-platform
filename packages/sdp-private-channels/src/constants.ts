import type { PrivateChannelInstanceConfig } from "./types";

/**
 * Public sandbox instance operated by the Solana Private Channels project. All identifiers
 * are on-chain public keys, not secrets.
 *
 * Solana L1 traffic uses the SDP project's configured RPC provider; it is not
 * part of this instance-specific configuration.
 */
export const SANDBOX_DEFAULTS: PrivateChannelInstanceConfig = {
  gatewayUrl: "http://34.71.147.163:8899",
  // biome-ignore lint/security/noSecrets: Public Solana program ID.
  escrowProgramId: "9tgHa1DcnaSSUtmMsst8ovKTe1Gfxzezn27KnH9xXYeU",
  // biome-ignore lint/security/noSecrets: Public Solana program ID.
  withdrawProgramId: "J231K9UEpS4y4KAPwGc4gsMNCjKFRMYcQBcjVW7vBhVi",
  // biome-ignore lint/security/noSecrets: Public Solana account address.
  escrowInstanceAddr: "7C1Pu8mbHaDDTFnGH8YTqemNDofqXP3XEotzSo6TbwHz",
  authUrl: "http://34.71.147.163:8903",
};
