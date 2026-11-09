import { SdpEarnError } from "@sdp/earn/errors";
import * as plumeApi from "@sdp/earn/providers/plume/api";
import * as rpcFactory from "@sdp/rpc/factory";
import { runInClusterScope } from "@sdp/rpc/scope";
import { PLUME_VAULTS } from "@sdp/types/plume-programs";
import { createSolanaRpcFromTransport, type RpcTransport } from "@solana/kit";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as chain from "./chain";
import { PlumeVaultDirectClient } from "./client";
import * as plan from "./plan";

const request = vi.fn(),
  read = vi.fn(),
  admit = vi.fn();

/** The RPC the client builds only flows into the spied chain read and plan admission. */
const unusedTransport: RpcTransport = async <T>(): Promise<T> => {
  throw new Error("This test never reaches the cluster RPC");
};
vi.spyOn(plumeApi, "plumeRequest").mockImplementation(request);
vi.spyOn(chain, "readPlumeVault").mockImplementation(read);
vi.spyOn(plan, "admitPlumeTransaction").mockImplementation(admit);
vi.spyOn(rpcFactory, "createClusterRpc").mockReturnValue(
  createSolanaRpcFromTransport(unusedTransport)
);

const ctx = { env: {}, environment: "production" } as const;
const vault = PLUME_VAULTS[0];
if (!vault) throw new Error("Missing deployment fixture");
const owner = "11111111111111111111111111111112";
const base = { providerReference: vault.shareMint, owner };
const production = <T>(operation: () => Promise<T>) =>
  runInClusterScope({ environment: "production", projectId: "test" }, operation);
beforeEach(() => {
  vi.clearAllMocks();
  read.mockResolvedValue({
    shareAta: "expected-account",
    shares: 10_000_000n,
    shareAccountExists: true,
  });
  request.mockResolvedValue({ txBase64: "fixture" });
  admit.mockResolvedValue({});
});
describe("Plume provider contract", () => {
  it("sends exact base-unit mint integers with Predicate v2", async () => {
    await production(() =>
      new PlumeVaultDirectClient().buildVaultDeposit(ctx, { ...base, amount: "1.000001" })
    );
    expect(request.mock.calls[0]?.[2]).toMatchObject({
      rawAmountUsdc: 1_000_001,
      complianceVersion: "v2",
      receiver: owner,
      nestVaultSlug: vault.slug,
    });
  });
  it("does not start a provider build after the operation deadline expires during RPC", async () => {
    let expired = false;
    read.mockImplementationOnce(async () => {
      expired = true;
      return { shareAta: "expected-account", shares: 0n, shareAccountExists: true };
    });
    const client = new PlumeVaultDirectClient(async (_label, operation) =>
      operation(() => {
        if (expired) throw new Error("deadline expired");
      })
    );
    await expect(
      production(() => client.buildVaultDeposit(ctx, { ...base, amount: "1" }))
    ).rejects.toMatchObject({ code: "VAULT_UNREADABLE" });
    expect(request).not.toHaveBeenCalled();
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
    expect(request).not.toHaveBeenCalled();
  });
  it("requires separate account setup before a sponsored first mint", async () => {
    read.mockResolvedValue({
      shareAta: "expected-account",
      shares: 0n,
      shareAccountExists: false,
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
    expect(request).not.toHaveBeenCalled();
  });
  it("maps a mint 403 to wallet compliance refusal", async () => {
    request.mockRejectedValue(new SdpEarnError("BAD_REQUEST", "refused", { providerStatus: 403 }));
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
      expect(request.mock.calls[0]?.[0]).toBe(
        mode === "standard" ? "/solana/nest/async-redeem/build-tx" : "/solana/nest/redeem/build-tx"
      );
      expect(request.mock.calls[0]?.[2]).toMatchObject({
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
    expect(request).not.toHaveBeenCalled();
  });
  it("treats status indexing 404 as pending", async () => {
    request.mockRejectedValue(new SdpEarnError("BAD_REQUEST", "indexing", { providerStatus: 404 }));
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
    request.mockResolvedValue({
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
