import type { EarnRuntimeContext, EarnVaultProvider } from "@sdp/earn/types";
import { describe, expect, it, vi } from "vitest";
import { AppError } from "@/lib/errors";
import { assertVaultDepositEligible } from "./deposit-eligibility";

const runtime: EarnRuntimeContext = { env: {}, environment: "production" };
const input = { providerReference: "FundMint1111", owner: "OwnerWallet1111" };

const baseClient = {
  provider: "wisdomtree",
  declaredSupport: { sourceKinds: ["rwa"], depositTokens: ["USDC"] },
  listStrategies: async () => [],
} as unknown as EarnVaultProvider;

describe("assertVaultDepositEligible", () => {
  it("is a no-op for providers without the capability (today's permissionless vaults)", async () => {
    await expect(assertVaultDepositEligible(baseClient, runtime, input)).resolves.toBeUndefined();
  });

  it("passes an eligible verdict through silently", async () => {
    const check = vi.fn().mockResolvedValue({ eligible: true });
    const client = Object.assign(Object.create(baseClient), { checkDepositEligibility: check });
    await expect(assertVaultDepositEligible(client, runtime, input)).resolves.toBeUndefined();
    expect(check).toHaveBeenCalledWith(runtime, input);
  });

  it("refuses an ineligible wallet with the provider's own reason, as a caller-fault 400", async () => {
    const client = Object.assign(Object.create(baseClient), {
      checkDepositEligibility: vi.fn().mockResolvedValue({
        eligible: false,
        reason: "This wallet is not registered with WisdomTree Connect.",
      }),
    });
    const refusal = await assertVaultDepositEligible(client, runtime, input).then(
      () => undefined,
      (error: unknown) => error
    );
    expect(refusal).toBeInstanceOf(AppError);
    expect((refusal as AppError).message).toMatch(/not registered with WisdomTree Connect/);
  });

  it("propagates a provider outage rather than failing open", async () => {
    const client = Object.assign(Object.create(baseClient), {
      checkDepositEligibility: vi.fn().mockRejectedValue(new Error("connect unreachable")),
    });
    await expect(assertVaultDepositEligible(client, runtime, input)).rejects.toThrowError(
      /connect unreachable/
    );
  });
});
