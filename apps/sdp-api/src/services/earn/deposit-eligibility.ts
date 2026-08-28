import { supportsDepositEligibility } from "@sdp/earn/capabilities";
import type { EarnRuntimeContext, EarnVaultProvider } from "@sdp/earn/types";
import { badRequest } from "@/lib/errors";

/**
 * The provider-side eligibility gate for vault MONEY-IN, capability-dispatched
 * (never a provider-id check) and shared by both deposit paths — custody-signed
 * and external-wallet — so the rule cannot drift between them.
 *
 * Exists for regulated instruments (WisdomTree): settlement pays out fund
 * tokens whose transfer hook refuses any wallet the issuer has not verified,
 * so a deposit from an ineligible wallet is USDC that leaves and nothing that
 * can come back. A provider without the capability is simply not gated —
 * today's behavior for every permissionless vault.
 *
 * MONEY-IN ONLY (ADR 0002): no exit path may ever call this. A wallet holding
 * the instrument proved its eligibility on-chain, and money out must never
 * inherit a money-in gate.
 */
export async function assertVaultDepositEligible(
  client: EarnVaultProvider,
  runtime: EarnRuntimeContext,
  input: { providerReference: string; owner: string }
): Promise<void> {
  if (!supportsDepositEligibility(client)) {
    return;
  }
  const verdict = await client.checkDepositEligibility(runtime, input);
  if (!verdict.eligible) {
    throw badRequest(
      verdict.reason ??
        `${client.provider} reports this wallet as ineligible to receive the instrument.`,
      { provider: client.provider, owner: input.owner, reason: verdict.reason }
    );
  }
}
