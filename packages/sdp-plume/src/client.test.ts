import { SdpEarnError } from "@sdp/earn/errors";
import { runInClusterScope } from "@sdp/rpc/scope";
import { PLUME_VAULTS } from "@sdp/types/plume-programs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { PlumeVaultDirectClient } from "./client";

const mocks = vi.hoisted(() => ({ request: vi.fn(), read: vi.fn(), admit: vi.fn() }));
vi.mock("@sdp/earn/providers/plume/api", async (original) => ({
  ...(await original<typeof import("@sdp/earn/providers/plume/api")>()),
  plumeRequest: mocks.request,
}));
vi.mock("./chain", () => ({ readPlumeVault: mocks.read }));
vi.mock("./plan", () => ({ admitPlumeTransaction: mocks.admit }));
vi.mock("@sdp/rpc/factory", () => ({ createClusterRpc: () => ({}) }));
const ctx = { env: {}, environment: "production" } as const;
const vault = PLUME_VAULTS[0];
if (!vault) throw new Error("Missing deployment fixture");
const owner = "11111111111111111111111111111112";
const base = { providerReference: vault.shareMint, owner };
const production = <T>(operation: () => Promise<T>) =>
  runInClusterScope({ environment: "production", projectId: "test" }, operation);
beforeEach(() => {
  vi.clearAllMocks();
  mocks.read.mockResolvedValue({ shares: 10_000_000n, shareAccountExists: true });
  mocks.request.mockResolvedValue({ txBase64: "fixture" });
  mocks.admit.mockResolvedValue({});
});
describe("Plume provider contract", () => {
  it("sends exact base-unit mint integers with Predicate v2", async () => {
    await production(() =>
      new PlumeVaultDirectClient().buildVaultDeposit(ctx, { ...base, amount: "1.000001" })
    );
    expect(mocks.request.mock.calls[0]?.[2]).toMatchObject({
      rawAmountUsdc: 1_000_001,
      complianceVersion: "v2",
      receiver: owner,
      nestVaultSlug: vault.slug,
    });
  });
  it("does not start a provider build after the operation deadline expires during RPC", async () => {
    let expired = false;
    mocks.read.mockImplementationOnce(async () => {
      expired = true;
      return { shares: 0n, shareAccountExists: true };
    });
    const client = new PlumeVaultDirectClient(async (_label, operation) =>
      operation(() => {
        if (expired) throw new Error("deadline expired");
      })
    );
    await expect(
      production(() => client.buildVaultDeposit(ctx, { ...base, amount: "1" }))
    ).rejects.toMatchObject({ code: "VAULT_UNREADABLE" });
    expect(mocks.request).not.toHaveBeenCalled();
  });
  it("refuses unsafe JavaScript integers before contacting the builder", async () => {
    await expect(
      production(() =>
        new PlumeVaultDirectClient().buildVaultDeposit(ctx, {
          ...base,
          amount: "9007199254.740992",
        })
      )
    ).rejects.toMatchObject({ code: "INVALID_AMOUNT" });
    expect(mocks.request).not.toHaveBeenCalled();
  });
  it("requires separate account setup before a sponsored first mint", async () => {
    mocks.read.mockResolvedValue({
      shares: 0n,
      shareAccountExists: false,
      shareAta: "expected-account",
    });
    await expect(
      production(() =>
        new PlumeVaultDirectClient().buildVaultDeposit(ctx, {
          ...base,
          amount: "1",
          rentPayer: "So11111111111111111111111111111111111111112",
        })
      )
    ).rejects.toMatchObject({ code: "DEPOSIT_REFUSED" });
    expect(mocks.request).not.toHaveBeenCalled();
  });
  it("maps a mint 403 to wallet compliance refusal", async () => {
    mocks.request.mockRejectedValue(
      new SdpEarnError("BAD_REQUEST", "refused", { providerStatus: 403 })
    );
    await expect(
      production(() =>
        new PlumeVaultDirectClient().buildVaultDeposit(ctx, { ...base, amount: "1" })
      )
    ).rejects.toMatchObject({ code: "COMPLIANCE_APPROVAL_REQUIRED" });
  });
  it.each(["standard", "instant"] as const)(
    "builds %s redemption with the documented amount wire type",
    async (mode) => {
      await production(() =>
        new PlumeVaultDirectClient().buildVaultWithdrawal(ctx, {
          ...base,
          shares: "1.5",
          redemptionMode: mode,
        })
      );
      expect(mocks.request.mock.calls[0]?.[0]).toBe(
        mode === "standard" ? "/solana/nest/async-redeem/build-tx" : "/solana/nest/redeem/build-tx"
      );
      expect(mocks.request.mock.calls[0]?.[2]).toMatchObject({
        rawAmountNestToken: mode === "standard" ? "1500000" : 1500000,
        complianceVersion: "v1",
      });
    }
  );
  it("does not invent a devnet deployment", async () => {
    await expect(
      runInClusterScope({ environment: "sandbox", projectId: "test" }, () =>
        new PlumeVaultDirectClient().buildVaultDeposit(
          { ...ctx, environment: "sandbox" },
          { ...base, amount: "1" }
        )
      )
    ).rejects.toMatchObject({ code: "DEPLOYMENT_NOT_CONFIGURED" });
    expect(mocks.request).not.toHaveBeenCalled();
  });
  it("treats status indexing 404 as pending", async () => {
    mocks.request.mockRejectedValue(
      new SdpEarnError("BAD_REQUEST", "indexing", { providerStatus: 404 })
    );
    const result = await production(() =>
      new PlumeVaultDirectClient().readProviderSettlement(ctx, {
        ...base,
        sourceSignature: "source",
        direction: "deposit",
      })
    );
    expect(result.destinationSignature).toBeNull();
    expect(result.phase).toBe("processing");
  });
  it("rejects a status record for another source or owner", async () => {
    mocks.request.mockResolvedValue({
      sourceSignature: "other",
      owner,
      destinationSignature: "delivery",
    });
    await expect(
      production(() =>
        new PlumeVaultDirectClient().readProviderSettlement(ctx, {
          ...base,
          sourceSignature: "source",
          direction: "withdrawal",
        })
      )
    ).rejects.toMatchObject({ code: "VAULT_UNREADABLE" });
  });
});
