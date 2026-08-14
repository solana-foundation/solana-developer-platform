/**
 * Which state source decides whether freeze/unfreeze actually touches the chain.
 *
 * The `frozen_accounts` mirror is written best-effort AFTER the chain op, so it can
 * disagree with the chain whenever a mirror write fails. Gating the chain call on the
 * mirror turned that single failed write into a permanent silent no-op: a wallet frozen
 * on chain with no mirror row made runUnfreeze report `alreadyThawed` without ever
 * thawing, leaving it frozen forever while the engine recorded success.
 *
 * These tests set the mirror and the chain to disagree and assert the chain wins.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkflowExecutionRow } from "@/db/repositories";
import type { Env } from "@/types/env";

const TOKEN_ACCOUNT = "So11111111111111111111111111111111111111112";
const WALLET = "AENLi9e2xTiK7YHThmEQhBrCaDTjTRV4hsDXdwbPcBbK";

// AccountState.Frozen === 2 in @solana-program/token-2022.
const fetchToken = vi.hoisted(() => vi.fn());
const freezeAccount = vi.hoisted(() => vi.fn());
const thawAccount = vi.hoisted(() => vi.fn());
// The stale mirror: it claims nothing is frozen, which is the post-failed-write state.
const isAccountFrozen = vi.hoisted(() => vi.fn());
const mirrorFreezeWrite = vi.hoisted(() => vi.fn());
const mirrorUnfreezeWrite = vi.hoisted(() => vi.fn());

vi.mock("@solana-program/token-2022", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@solana-program/token-2022")>()),
  fetchToken,
}));
vi.mock("@sdp/rpc/solana", () => ({ createRpcForSdk: () => ({}) }));
vi.mock("@/db", () => ({ getDb: () => ({}) }));
vi.mock("@/services/token.service", () => ({
  TokenService: class {
    isAccountFrozen = isAccountFrozen;
    freezeAccount = mirrorFreezeWrite;
    unfreezeAccount = mirrorUnfreezeWrite;
  },
}));
vi.mock("./record-transaction", () => ({ recordWorkflowTransaction: async () => true }));

// prepareOnchain reaches custody and RPC; the signer/mosaic surface is all these actions
// use from it. resolveWalletTokenAccount is a live RPC derive, stubbed to a fixed account.
vi.mock("./onchain", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./onchain")>();
  return {
    ...actual,
    prepareOnchain: async () => ({
      ok: true,
      ctx: {
        mintAddress: TOKEN_ACCOUNT,
        signer: { address: WALLET },
        mosaic: { freezeAccount, thawAccount },
      },
    }),
    resolveWalletTokenAccount: async () => TOKEN_ACCOUNT,
  };
});

import { runFreeze, runUnfreeze } from "./lifecycle";

const env = {} as Env;

function executionFixture(): WorkflowExecutionRow {
  return {
    id: "workflow_execution_lifecycle",
    organization_id: "org_1",
    project_id: "prj_1",
    workflow_id: "asset_workflow_1",
    token_id: "tok_1",
    trigger_type: "kyc_rejected",
    action_type: "freeze",
    status: "processing",
    idempotency_key: "kyc_rejected:1",
    trigger_payload: { wallet: WALLET },
    result: {},
    attempt_count: 1,
    max_attempts: 5,
    next_attempt_at: null,
    locked_at: null,
    error: null,
    decided_by: null,
    decided_at: null,
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
  } as WorkflowExecutionRow;
}

const action = { type: "freeze", params: {} } as never;

function chainSays(state: "frozen" | "thawed") {
  fetchToken.mockResolvedValue({ data: { state: state === "frozen" ? 2 : 1 } });
}

describe("freeze/unfreeze converge on chain state, not the DB mirror", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    freezeAccount.mockResolvedValue({ signature: "sig_freeze", slot: 1 });
    thawAccount.mockResolvedValue({ signature: "sig_thaw", slot: 2 });
    mirrorFreezeWrite.mockResolvedValue(undefined);
    mirrorUnfreezeWrite.mockResolvedValue(undefined);
  });

  // The reported bug. The mirror write failed after an earlier freeze landed, so the
  // table has no row — but the wallet is frozen on chain and must actually be thawed.
  it("thaws an account the stale mirror does not know is frozen", async () => {
    isAccountFrozen.mockResolvedValue(false);
    chainSays("frozen");

    const result = await runUnfreeze(env, executionFixture(), action);

    expect(thawAccount).toHaveBeenCalledTimes(1);
    expect(result.status).toBe("succeeded");
    expect(result.result).not.toMatchObject({ alreadyThawed: true });
  });

  // The converse: the mirror still holds a row for an account that is thawed on chain,
  // so a freeze rule must actually freeze rather than declare itself already done.
  it("freezes an account the stale mirror already considers frozen", async () => {
    isAccountFrozen.mockResolvedValue(true);
    chainSays("thawed");

    const result = await runFreeze(env, executionFixture(), action);

    expect(freezeAccount).toHaveBeenCalledTimes(1);
    expect(result.status).toBe("succeeded");
    expect(result.result).not.toMatchObject({ alreadyFrozen: true });
  });

  // Idempotency still holds where it should — this is what the pre-check exists for, so
  // a retry after a landed op must not re-submit and fail on the raw chain error.
  it("does not re-thaw an account already thawed on chain", async () => {
    isAccountFrozen.mockResolvedValue(true);
    chainSays("thawed");

    const result = await runUnfreeze(env, executionFixture(), action);

    expect(thawAccount).not.toHaveBeenCalled();
    expect(result.result).toMatchObject({ alreadyThawed: true });
  });

  it("does not re-freeze an account already frozen on chain", async () => {
    isAccountFrozen.mockResolvedValue(false);
    chainSays("frozen");

    const result = await runFreeze(env, executionFixture(), action);

    expect(freezeAccount).not.toHaveBeenCalled();
    expect(result.result).toMatchObject({ alreadyFrozen: true });
  });

  // An unreadable chain state must not be guessed at in either direction: it becomes a
  // retry, not a silent skip and not a blind re-submit.
  it("retries rather than deciding when the chain state cannot be read", async () => {
    isAccountFrozen.mockResolvedValue(false);
    fetchToken.mockRejectedValue(new Error("rpc timeout"));

    const result = await runUnfreeze(env, executionFixture(), action);

    expect(thawAccount).not.toHaveBeenCalled();
    expect(result.status).toBe("failed");
    expect(result.retryable).toBe(true);
  });
});
