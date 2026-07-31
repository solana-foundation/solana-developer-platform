export {
  createAuthClient,
  type SpcAuthClient,
  type SpcAuthClientOptions,
  type SpcLoginInput,
  type SpcLoginResult,
  type SpcRegisteredUser,
  type SpcRegisterInput,
  type SpcVerifiedWallet,
  type SpcWalletChallenge,
  spcLogin,
  spcRegister,
  type VerifyWalletInput,
} from "./auth";
export * from "./channels";
export { SANDBOX_DEFAULTS } from "./constants";
export {
  badRequest,
  PrivateChannelError,
  type PrivateChannelErrorCode,
} from "./errors";
export {
  type ChannelTokenAccountBalance,
  type ChannelTokenBalanceResult,
  createChannelGatewayRpc,
  type GatewayClientOptions,
  getChannelTokenBalance,
} from "./gateway";
export {
  type GatewayHealthResult,
  type GatewayProbeResponse,
  probeGatewayHealth,
} from "./health";
export {
  type ConnectionProbeInput,
  type ConnectionProbeResult,
  probeConnection,
} from "./probe";
export { probeSolanaRpc, type SolanaRpcProbeResult } from "./rpc";
export {
  type PrivateChannelInstanceInputSchema,
  privateChannelInstanceInputSchema,
} from "./schema";
export type {
  GatewayHealth,
  PrivateChannelInstance,
  PrivateChannelInstanceConfig,
  PrivateChannelInstanceInput,
} from "./types";
export { assertHttpUrl, normalizeHttpBase, parseHttpUrl } from "./url";
