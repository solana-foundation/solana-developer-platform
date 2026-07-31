import type { Signature } from "@solana/kit";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  PrivateChannelTransferRepository,
  PrivateChannelTransferRow,
} from "@/db/repositories";
import type { Env } from "@/types/env";

// Mock the RPC transport so we can simulate confirm outcomes + transport errors.
const { confirmTransaction } = vi.hoisted(() => ({ confirmTransaction: vi.fn() }));
vi.mock("@sdp/rpc/solana", () => ({ confirmTransaction }));

const { withGatewayRpc } = vi.hoisted(() => ({
  withGatewayRpc: vi.fn(async (_env, _url, _ctx, run: (rpc: unknown) => Promise<unknown>) =>
    run({})
  ),
}));
vi.mock("./auth/gateway-auth", () => ({ withGatewayRpc }));

import { confirmAndPersistTransfer } from "./transfer-confirm";

const env = {} as Env;
const SIGNATURE = "sig-transfer-1" as Signature;

function makeRepo() {
  const updateTransfer = vi.fn(
    async (input: { id: string; status: string; failureReason?: string | null }) =>
      ({
        id: input.id,
        status: input.status,
        failure_reason: input.failureReason ?? null,
      }) as unknown as PrivateChannelTransferRow
  );
  return { updateTransfer } as unknown as PrivateChannelTransferRepository & {
    updateTransfer: ReturnType<typeof vi.fn>;
  };
}

function run(repo: PrivateChannelTransferRepository) {
  return confirmAndPersistTransfer(env, repo, {
    transferId: "pct_1",
    gatewayUrl: "https://gateway",
    signature: SIGNATURE,
    gatewayAuth: { current: "jwt", refresh: vi.fn(), pcUserId: "pcu_1" },
  });
}

beforeEach(() => {
  confirmTransaction.mockClear();
  withGatewayRpc.mockClear();
});

describe("confirmAndPersistTransfer", () => {
  it("marks the transfer confirmed on a clean execution", async () => {
    const repo = makeRepo();
    confirmTransaction.mockResolvedValueOnce({ err: null });

    const result = await run(repo);

    expect(result).toMatchObject({ status: "confirmed" });
    // CAS'd on `submitted`, and no signature passed so the stored one is preserved.
    expect(repo.updateTransfer).toHaveBeenCalledWith({
      id: "pct_1",
      status: "confirmed",
      expectedStatus: "submitted",
    });
  });

  it("records the real transaction error when execution failed", async () => {
    const repo = makeRepo();
    confirmTransaction.mockResolvedValueOnce({
      err: { InstructionError: [1, "InvalidAccountData"] },
    });

    const result = await run(repo);

    expect(result).toMatchObject({ status: "failed" });
    expect(repo.updateTransfer).toHaveBeenCalledWith({
      id: "pct_1",
      status: "failed",
      failureReason: '{"InstructionError":[1,"InvalidAccountData"]}',
      expectedStatus: "submitted",
    });
  });

  // A transport error is not evidence either way, so the row must keep its
  // `submitted` state rather than be guessed into a terminal one.
  it("leaves the transfer submitted when the read fails in transport", async () => {
    const repo = makeRepo();
    confirmTransaction.mockRejectedValueOnce(new Error("network timeout"));

    expect(await run(repo)).toBeNull();
    expect(repo.updateTransfer).not.toHaveBeenCalled();
  });

  // SPC's dedup stage drops a stale-blockhash or duplicate transaction silently, so
  // it never appears in a status read and the confirm budget expires. Still not a
  // failure we can assert: the row stays `submitted` for an operator.
  it("leaves the transfer submitted when it never appears (silent dedup drop)", async () => {
    const repo = makeRepo();
    confirmTransaction.mockRejectedValueOnce(
      new Error(`Transaction ${SIGNATURE} confirmation timed out after 5000ms`)
    );

    expect(await run(repo)).toBeNull();
    expect(repo.updateTransfer).not.toHaveBeenCalled();
  });

  it("reads the status through the gateway auth wrapper", async () => {
    const repo = makeRepo();
    confirmTransaction.mockResolvedValueOnce({ err: null });

    await run(repo);

    expect(withGatewayRpc).toHaveBeenCalledOnce();
    // Bounded well below the 60s default: a dropped transaction must not hang a
    // user-facing request for a minute.
    expect(confirmTransaction).toHaveBeenCalledWith(
      expect.anything(),
      SIGNATURE,
      expect.objectContaining({ timeoutMs: 5_000 })
    );
  });
});
