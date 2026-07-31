import type { PrivateChannelInstanceConfig } from "./types";

/**
 * Public sandbox instance operated by the Solana Private Channels project. All identifiers
 * are on-chain public keys, not secrets.
 *
 * `chainRpcUrl` is a template, not a working endpoint: devnet's public RPC is
 * heavily rate-limited and the escrow deposit/withdraw path submits real
 * transactions, so operators supply their own API key.
 */
export const SANDBOX_DEFAULTS: PrivateChannelInstanceConfig = {
  gatewayUrl: "http://34.71.147.163:8899",
  chainRpcUrl: "https://devnet.helius-rpc.com/?api-key=XXXXXXX",
  // biome-ignore lint/security/noSecrets: Public Solana program ID.
  escrowProgramId: "9tgHa1DcnaSSUtmMsst8ovKTe1Gfxzezn27KnH9xXYeU",
  // biome-ignore lint/security/noSecrets: Public Solana program ID.
  withdrawProgramId: "J231K9UEpS4y4KAPwGc4gsMNCjKFRMYcQBcjVW7vBhVi",
  // biome-ignore lint/security/noSecrets: Public Solana account address.
  escrowInstanceAddr: "7C1Pu8mbHaDDTFnGH8YTqemNDofqXP3XEotzSo6TbwHz",
  authUrl: "http://34.71.147.163:8903",
};
