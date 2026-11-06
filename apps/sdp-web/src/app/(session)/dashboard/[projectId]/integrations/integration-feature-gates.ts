import type { CustodyProviderUseCase } from "@sdp/types/custody";
import type { SdpModule } from "@sdp/types/release-channels";
import { isModuleInDeploymentReleaseChannel } from "@/flags/release-channel";

/** The module that delivers each custody use case. Transfers are custody wallets' own. */
const CUSTODY_USE_CASE_MODULES = {
  issuance: "issuance",
  transfers: "custody",
  compliance: "compliance",
} as const satisfies Record<CustodyProviderUseCase, SdpModule>;

/**
 * A custody provider's use cases the deployment's release channel runs, so its Capabilities
 * never advertise a module the deployment refuses (Issuance on `stable`).
 *
 * @param useCases - The provider's use cases.
 * @returns The use cases whose module the channel runs, in their given order.
 */
export function custodyUseCasesInDeploymentReleaseChannel(
  useCases: readonly CustodyProviderUseCase[]
): CustodyProviderUseCase[] {
  return useCases.filter((useCase) =>
    isModuleInDeploymentReleaseChannel(CUSTODY_USE_CASE_MODULES[useCase])
  );
}
