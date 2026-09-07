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
export { type GatewayHealthResult, probeGatewayHealth } from "./health";
export {
  type AuthProbeResult,
  type ConnectionProbeInput,
  type ConnectionProbeResult,
  probeConnection,
} from "./probe";
export { probeSolanaRpc, type SolanaRpcProbeResult } from "./rpc";
export {
  type PrivateChannelInstanceInputSchema,
  privateChannelInstanceInputSchema,
} from "./schema";
export {
  MAX_PROBE_DETAIL_CHARS,
  type ProbeRequest,
  type ProbeResponse,
  type ProbeTransport,
  truncateProbeDetail,
} from "./transport";
export type {
  GatewayHealth,
  PrivateChannelInstance,
  PrivateChannelInstanceConfig,
  PrivateChannelInstanceInput,
} from "./types";
export { assertHttpUrl, normalizeHttpBase, parseHttpUrl } from "./url";
