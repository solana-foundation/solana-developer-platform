import { notImplemented } from "../errors";
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
} from "../types";

/**
 * Scaffold base for vault-infra clients: every `EarnVaultProvider` operation
 * throws NOT_IMPLEMENTED until the concrete integration lands. Subclasses
 * exist so the registry, availability gating, and route dispatch are all real
 * today; an integration lands method-by-method by overriding here.
 */
export abstract class StubEarnClient implements EarnVaultProvider {
  abstract readonly provider: EarnVaultProvider["provider"];
  abstract readonly declaredSupport: EarnDeclaredStrategySupport;

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
