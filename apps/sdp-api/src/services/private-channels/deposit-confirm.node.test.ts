import type { Signature } from "@solana/kit";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PrivateChannelDepositRepository, PrivateChannelDepositRow } from "@/db/repositories";
import type { Env } from "@/types/env";

// Mock the RPC transport so we can simulate confirm outcomes + transport errors.
const { createRpc, confirmTransaction } = vi.hoisted(() => ({
  createRpc: vi.fn(() => ({})),
  confirmTransaction: vi.fn(),
}));
vi.mock("@sdp/rpc/solana", () => ({ createRpc, confirmTransaction }));

import { confirmAndPersistDeposit } from "./deposit-confirm";

const env = {} as Env;
const SIGNATURE = "sig-123" as Signature;

function makeRepo() {
  const updateDeposit = vi.fn(
    async (input: { id: string; status: string }) =>
      ({ id: input.id, status: input.status }) as unknown as PrivateChannelDepositRow
  );
  return { updateDeposit } as unknown as PrivateChannelDepositRepository & {
    updateDeposit: ReturnType<typeof vi.fn>;
  };
}

beforeEach(() => {
  createRpc.mockClear();
  confirmTransaction.mockClear();
});

describe("confirmAndPersistDeposit", () => {
  it("leaves the deposit submitted when confirmation throws (transport/timeout)", async () => {
    const repo = makeRepo();
    confirmTransaction.mockRejectedValueOnce(new Error("network timeout"));

    const result = await confirmAndPersistDeposit(env, repo, {
      depositId: "dep_1",
      chainRpcUrl: "https://devnet",
      signature: SIGNATURE,
    });

    // No status change persisted; the reconciler will finalize it later.
    expect(result).toBeNull();
    expect(repo.updateDeposit).not.toHaveBeenCalled();
  });

  it("marks the deposit confirmed on a clean confirmation", async () => {
    const repo = makeRepo();
    confirmTransaction.mockResolvedValueOnce({ err: null });

    await confirmAndPersistDeposit(env, repo, {
      depositId: "dep_1",
      chainRpcUrl: "https://devnet",
      signature: SIGNATURE,
    });

    expect(repo.updateDeposit).toHaveBeenCalledWith(
      expect.objectContaining({ id: "dep_1", status: "confirmed", expectedStatus: "submitted" })
    );
  });

  it("marks the deposit failed only on a real on-chain error", async () => {
    const repo = makeRepo();
    confirmTransaction.mockResolvedValueOnce({ err: { InstructionError: [0, "Custom"] } });

    await confirmAndPersistDeposit(env, repo, {
      depositId: "dep_1",
      chainRpcUrl: "https://devnet",
      signature: SIGNATURE,
    });

    expect(repo.updateDeposit).toHaveBeenCalledWith(
      expect.objectContaining({ id: "dep_1", status: "failed" })
    );
  });
});
