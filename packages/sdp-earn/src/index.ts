import type { EarnProviderId } from "@sdp/types/provider-access";
import { providerNotConfigured } from "./errors";
import { GroundEarnClient } from "./providers/ground/client";
import { KaminoEarnClient } from "./providers/kamino/client";
import { PerenaEarnClient } from "./providers/perena/client";
import { UpshiftEarnClient } from "./providers/upshift/client";
import { VedaEarnClient } from "./providers/veda/client";
import type { EarnVaultProvider } from "./types";

export {
  supportsLiveMetrics,
  supportsPortfolioWallets,
  supportsWithdrawalApprovals,
} from "./capabilities";
export {
  badRequest,
  internalError,
  notImplemented,
  providerNotConfigured,
  providerUnavailable,
  SdpEarnError,
  type SdpEarnErrorCode,
} from "./errors";
export { GroundEarnClient } from "./providers/ground/client";
export { KaminoEarnClient } from "./providers/kamino/client";
export { PerenaEarnClient } from "./providers/perena/client";
export { StubEarnClient } from "./providers/stub";
export { UpshiftEarnClient } from "./providers/upshift/client";
export { VedaEarnClient } from "./providers/veda/client";
export { isClusterFundableInEnvironment, isStrategyWithinDeclaredSupport } from "./support";
export type {
  EarnDeclaredStrategySupport,
  EarnLiveMetricsProvider,
  EarnPendingWithdrawalApproval,
  EarnPortfolioAddressBookEntryInput,
  EarnPortfolioAddressBookEntryResult,
  EarnPortfolioDepositsInput,
  EarnPortfolioStrategyUpdateInput,
  EarnPortfolioStrategyUpdateResult,
  EarnPortfolioWalletCreateInput,
  EarnPortfolioWalletCreateResult,
  EarnPortfolioWalletProvider,
  EarnPortfolioWalletRefInput,
  EarnPortfolioWithdrawalCreateInput,
  EarnPortfolioWithdrawalPreviewInput,
  EarnPortfolioWithdrawalStatusInput,
  EarnRuntimeContext,
  EarnRuntimeEnvironment,
  EarnVaultProvider,
  EarnWithdrawalApprovalAction,
  EarnWithdrawalApprovalProvider,
  EarnWithdrawalApprovalRequest,
  EarnWithdrawalApprovalRequestInput,
  EarnWithdrawalApprovalStamp,
  EarnWithdrawalApprovalVoteInput,
  EarnWithdrawalApprovalVoteResult,
  ProviderStrategyMetrics,
  ProviderStrategySnapshot,
} from "./types";

/**
 * Module-level singletons so API route tests can `vi.spyOn` a provider method
 * without touching dispatch — same shape as RAMP_PROVIDER_CLIENTS.
 */
export const EARN_PROVIDER_CLIENTS = {
  veda: new VedaEarnClient(),
  upshift: new UpshiftEarnClient(),
  perena: new PerenaEarnClient(),
  ground: new GroundEarnClient(),
  kamino: new KaminoEarnClient(),
} as const satisfies Record<EarnProviderId, EarnVaultProvider>;

export function isEarnProviderId(value: string): value is EarnProviderId {
  // Object.hasOwn, not `in`: provider ids come from open TEXT columns, and a
  // prototype key like "toString" must not defeat the fail-closed guard.
  return Object.hasOwn(EARN_PROVIDER_CLIENTS, value);
}

/**
 * Registry lookup that survives catalogue drift. Strategy rows persist
 * `provider` as open TEXT, so a row written by a newer deploy — or one whose
 * provider was since retired from the registry — must fail closed with a
 * clean 503, never an undefined-dispatch TypeError.
 */
export function resolveEarnProviderClient(provider: string): EarnVaultProvider {
  if (!isEarnProviderId(provider)) {
    throw providerNotConfigured(`Earn provider ${provider} is not available in this deployment`);
  }
  return EARN_PROVIDER_CLIENTS[provider];
}
