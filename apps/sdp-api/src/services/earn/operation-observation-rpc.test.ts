import { runInClusterScope } from "@sdp/rpc/scope";
import { getBase58Decoder } from "@solana/kit";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OperationScope } from "@/db/repositories/operations.repository";
import { runAsMoneyPrincipal } from "@/lib/money-principal";
import { createOperationObservationRpc } from "./operation-observation-rpc";

const mocks = vi.hoisted(() => ({ client: vi.fn(), height: vi.fn(), statuses: vi.fn() }));
vi.mock("@sdp/rpc/factory", () => ({
  createClusterRpc: (...args: unknown[]) => {
    mocks.client(...args);
    return {
      getSignatureStatuses: (values: readonly string[], config: unknown) => ({
        send: () => mocks.statuses(values, config),
      }),
    };
  },
}));
vi.mock("./vault-intent-execution.service", () => ({ readConfirmedBlockHeight: mocks.height }));
const scope: OperationScope = {
  organizationId: "org",
  projectId: "project",
  environment: "sandbox",
};
const signatures = [1, 2].map((value) => getBase58Decoder().decode(new Uint8Array(64).fill(value)));
const first = signatures[0];
const second = signatures[1];
if (first === undefined || second === undefined) throw new Error("Signature fixtures are missing");
const scoped = <T>(work: () => T) =>
  runInClusterScope({ projectId: null, environment: "sandbox" }, work);
beforeEach(() => {
  vi.resetAllMocks();
  mocks.height.mockResolvedValue(100n);
  mocks.statuses.mockImplementation(async (values: readonly string[]) => ({
    value: values.map(() => null),
  }));
});

describe("scoped operation observations", () => {
  it("creates no client until needed and shares one client, height and batched status read", async () =>
    scoped(async () => {
      const reads = createOperationObservationRpc();
      expect(mocks.client).not.toHaveBeenCalled();
      const values = await Promise.all([
        reads.confirmedHeight(scope),
        reads.confirmedHeight(scope),
        reads.hasSignature(scope, first),
        reads.hasSignature(scope, second),
        reads.hasSignature(scope, first),
      ]);
      expect(values).toEqual([100n, 100n, false, false, false]);
      expect(mocks.client).toHaveBeenCalledTimes(1);
      expect(mocks.height).toHaveBeenCalledTimes(1);
      expect(mocks.statuses).toHaveBeenCalledTimes(1);
      expect(mocks.statuses).toHaveBeenCalledWith([first, second], {
        searchTransactionHistory: true,
      });
    }));

  it("isolates org, project and recorded-principal clients and batches", async () =>
    scoped(async () => {
      const reads = createOperationObservationRpc();
      await Promise.all([
        reads.hasSignature(scope, first),
        reads.hasSignature({ ...scope, organizationId: "other-org" }, first),
        reads.hasSignature({ ...scope, projectId: "other-project" }, first),
        runAsMoneyPrincipal({ kind: "member", userId: "other-user" }, () =>
          reads.hasSignature(scope, first)
        ),
      ]);
      expect(mocks.client).toHaveBeenCalledTimes(4);
      expect(mocks.statuses).toHaveBeenCalledTimes(4);
    }));

  it("refuses reuse after the cluster or open project scope changes", async () => {
    const reads = scoped(() => createOperationObservationRpc());
    await expect(
      runInClusterScope({ projectId: null, environment: "production" }, () =>
        reads.confirmedHeight({ ...scope, environment: "production" })
      )
    ).rejects.toThrow("scope changed");
    await expect(
      runInClusterScope({ projectId: "project", environment: "sandbox" }, () =>
        reads.hasSignature(scope, first)
      )
    ).rejects.toThrow("scope changed");
    expect(mocks.client).not.toHaveBeenCalled();
  });

  it("does not retain failed height reads or reuse a height for another principal", async () =>
    scoped(async () => {
      const reads = createOperationObservationRpc();
      mocks.height.mockRejectedValueOnce(new Error("RPC unavailable"));
      await expect(reads.confirmedHeight(scope)).rejects.toThrow("RPC unavailable");
      expect(await reads.confirmedHeight(scope)).toBe(100n);
      await runAsMoneyPrincipal({ kind: "member", userId: "other-user" }, () =>
        reads.confirmedHeight(scope)
      );
      expect(mocks.height).toHaveBeenCalledTimes(3);
      expect(mocks.client).toHaveBeenCalledTimes(2);
    }));

  it("does not cache missing signatures or failed status reads", async () =>
    scoped(async () => {
      const reads = createOperationObservationRpc();
      mocks.statuses.mockRejectedValueOnce(new Error("RPC unavailable"));
      await expect(reads.hasSignature(scope, first)).rejects.toThrow("RPC unavailable");
      expect(await reads.hasSignature(scope, first)).toBe(false);
      mocks.statuses.mockResolvedValueOnce({ value: [{ slot: 1n }] });
      expect(await reads.hasSignature(scope, first)).toBe(true);
      expect(mocks.statuses).toHaveBeenCalledTimes(3);
      expect(mocks.client).toHaveBeenCalledTimes(1);
    }));

  it("rejects an incomplete batch without interpreting it as signature absence", async () =>
    scoped(async () => {
      const reads = createOperationObservationRpc();
      mocks.statuses.mockResolvedValueOnce({ value: [] });
      await expect(reads.hasSignature(scope, first)).rejects.toThrow(
        "Incomplete operation signature statuses"
      );
      expect(await reads.hasSignature(scope, first)).toBe(false);
    }));

  it("caps each RPC request at 256 distinct signatures", async () =>
    scoped(async () => {
      const reads = createOperationObservationRpc();
      const values = Array.from({ length: 257 }, (_, index) => {
        const bytes = new Uint8Array(64).fill(1);
        bytes[0] = index % 256;
        bytes[1] = Math.floor(index / 256);
        return getBase58Decoder().decode(bytes);
      });
      await Promise.all(values.map((value) => reads.hasSignature(scope, value)));
      expect(mocks.statuses.mock.calls.map((call) => call[0].length)).toEqual([256, 1]);
      expect(mocks.client).toHaveBeenCalledTimes(1);
    }));
});
