import { notImplemented } from "../errors";
import type {
  EarnDeclaredStrategySupport,
  EarnRuntimeContext,
  EarnVaultProvider,
  ProviderStrategySnapshot,
} from "../types";

/**
 * Scaffold base for vault-infra clients: every `EarnVaultProvider` operation
 * throws NOT_IMPLEMENTED until the concrete integration lands. Subclasses
 * exist so the registry, availability gating, and route dispatch are all real
 * today; an integration lands method-by-method by overriding here (Ground
 * overrides `listStrategies` and adds the portfolio/approval capabilities).
 */
export abstract class StubEarnClient implements EarnVaultProvider {
  abstract readonly provider: EarnVaultProvider["provider"];
  abstract readonly declaredSupport: EarnDeclaredStrategySupport;

  async listStrategies(_ctx: EarnRuntimeContext): Promise<ProviderStrategySnapshot[]> {
    throw notImplemented(this.provider, "listStrategies");
  }
}
