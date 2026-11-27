import { isEarnProviderId } from "@sdp/earn";
import type {
  EarnProvenRpcResolver,
  EarnRuntimeContext,
  EarnSwapPort,
  EarnVaultOperationRunner,
  EarnVaultProvider,
} from "@sdp/earn/types";
import { HastraVaultDirectClient } from "@sdp/hastra/client";
import { JupiterLendVaultDirectClient } from "@sdp/jupiter-lend/client";
import { KaminoVaultDirectClient } from "@sdp/kamino/client";
import { OndoVaultDirectClient } from "@sdp/ondo/client";
import { PlumeVaultDirectClient } from "@sdp/plume/client";
import type { EarnProviderId } from "@sdp/types/provider-access";
import { VedaVaultDirectClient } from "@sdp/veda/client";
import { WisdomTreeVaultDirectClient } from "@sdp/wisdomtree/client";

/** Runtime seams shared by singleton and operation-scoped execution clients. */
export interface EarnExecutionDependencies {
  readonly resolveProvenRpcUrl: EarnProvenRpcResolver;
  readonly runOperation: EarnVaultOperationRunner;
  readonly resolveJupiterSwapPort: (ctx: EarnRuntimeContext) => EarnSwapPort;
  readonly resolveHastraSwapPort: (ctx: EarnRuntimeContext) => EarnSwapPort;
}

type EarnExecutionFactory = (dependencies: EarnExecutionDependencies) => EarnVaultProvider;

/** One construction registration per provider; null explicitly means catalogue-only. */
const EARN_EXECUTION_FACTORIES = {
  veda: (dependencies) =>
    new VedaVaultDirectClient(dependencies.resolveProvenRpcUrl, dependencies.runOperation),
  upshift: null,
  perena: null,
  kamino: (dependencies) =>
    new KaminoVaultDirectClient(dependencies.resolveProvenRpcUrl, dependencies.runOperation),
  jupiter_lend: (dependencies) =>
    new JupiterLendVaultDirectClient(dependencies.resolveProvenRpcUrl, dependencies.runOperation),
  ondo: (dependencies) =>
    new OndoVaultDirectClient(
      dependencies.resolveProvenRpcUrl,
      dependencies.runOperation,
      dependencies.resolveJupiterSwapPort
    ),
  hastra: (dependencies) =>
    new HastraVaultDirectClient(
      dependencies.resolveProvenRpcUrl,
      dependencies.runOperation,
      dependencies.resolveHastraSwapPort
    ),
  wisdomtree: (dependencies) =>
    new WisdomTreeVaultDirectClient(dependencies.resolveProvenRpcUrl, dependencies.runOperation),
  plume: (dependencies) => new PlumeVaultDirectClient(dependencies.runOperation),
} as const satisfies Record<EarnProviderId, EarnExecutionFactory | null>;

/** Construct lazily without RPC or credential reads; stored unknown IDs remain unavailable. */
export function createEarnExecutionClient(
  provider: string,
  dependencies: EarnExecutionDependencies
): EarnVaultProvider | null {
  if (!isEarnProviderId(provider)) return null;
  const factory = EARN_EXECUTION_FACTORIES[provider];
  return factory === null ? null : factory(dependencies);
}
