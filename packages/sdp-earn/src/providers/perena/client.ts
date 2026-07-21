import { notImplemented } from "../../errors";
import type {
  EarnDeclaredStrategySupport,
  EarnDepositIntent,
  EarnDepositQuote,
  EarnDepositQuoteInput,
  EarnNavInput,
  EarnRuntimeContext,
  EarnVaultProvider,
  EarnWithdrawalIntent,
  EarnWithdrawalQuote,
  EarnWithdrawalQuoteInput,
  ProviderNavSnapshot,
  ProviderStrategySnapshot,
} from "../../types";

/**
 * Perena vault-infra client — scaffold stub. Every operation throws
 * NOT_IMPLEMENTED until the integration lands.
 */
export class PerenaEarnClient implements EarnVaultProvider {
  readonly provider = "perena" as const;
  readonly declaredSupport: EarnDeclaredStrategySupport = {
    sourceKinds: ["defi"],
    depositTokens: ["USDC", "USDG", "USDT"],
  };

  async listStrategies(_ctx: EarnRuntimeContext): Promise<ProviderStrategySnapshot[]> {
    throw notImplemented(this.provider, "listStrategies");
  }

  async getNav(_ctx: EarnRuntimeContext, _input: EarnNavInput): Promise<ProviderNavSnapshot> {
    throw notImplemented(this.provider, "getNav");
  }

  async quoteDeposit(
    _ctx: EarnRuntimeContext,
    _input: EarnDepositQuoteInput
  ): Promise<EarnDepositQuote> {
    throw notImplemented(this.provider, "quoteDeposit");
  }

  async createDeposit(
    _ctx: EarnRuntimeContext,
    _input: EarnDepositQuoteInput
  ): Promise<EarnDepositIntent> {
    throw notImplemented(this.provider, "createDeposit");
  }

  async quoteWithdrawal(
    _ctx: EarnRuntimeContext,
    _input: EarnWithdrawalQuoteInput
  ): Promise<EarnWithdrawalQuote> {
    throw notImplemented(this.provider, "quoteWithdrawal");
  }

  async createWithdrawal(
    _ctx: EarnRuntimeContext,
    _input: EarnWithdrawalQuoteInput
  ): Promise<EarnWithdrawalIntent> {
    throw notImplemented(this.provider, "createWithdrawal");
  }
}
