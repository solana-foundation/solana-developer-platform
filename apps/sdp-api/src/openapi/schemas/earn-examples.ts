import type { EarnStrategy } from "@sdp/types/earn";
import { earnStrategyParticipation } from "@sdp/types/provider-access";
import { WELL_KNOWN_TOKENS } from "@sdp/types/well-known-tokens";

/** Stable identities shared by the core contract examples. */
export const EARN_EXAMPLE_IDS = {
  strategy: "earn_strategy_3b6a81ce-00b0-4c5a-9761-cb359932e97e",
  mainnetStrategy: "earn_strategy_8d1f0c52-6a3e-4b7e-9f21-3c5d7a9e4b10",
  position: "earn_position_3b6a81ce-00b0-4c5a-9761-cb359932e97e",
};
const IDS = EARN_EXAMPLE_IDS;
export const EARN_OWNER_ADDRESS_EXAMPLE = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";

export const EARN_STRATEGY_EXAMPLE = {
  ...earnStrategyParticipation("kamino"),
  id: IDS.mainnetStrategy,
  provider: "kamino",
  providerReference: "BEEfo7xwgK2ZP13Pxo7qqTPzAteKJmXjVWtMWcXSvbn2",
  name: "Steakhouse High Yield USDC",
  sourceKind: "defi",
  underlyingSource: "klend",
  depositMints: [WELL_KNOWN_TOKENS.USDC.mints["mainnet-beta"].address],
  shareMint: "FU2tGk7tFHEhZiZ516TKgpPqPwXYXHTeRHqvuDwa56UV",
  apyType: "variable",
  currentApy: "0.045113",
  liquidityTerm: "instant",
  riskMetadata: { managementFeeBps: 0, performanceFeeBps: 500 },
  status: "active",
  depositSlippage: { quoteRequired: true, defaultToleranceBps: 10 },
  withdrawalSlippage: null,
  hostCluster: "mainnet-beta",
  fundable: true,
  feeSponsored: false,
  createdAt: "2026-11-04T00:17:15.491Z",
  updatedAt: "2026-11-06T17:52:10.042Z",
} satisfies EarnStrategy;
