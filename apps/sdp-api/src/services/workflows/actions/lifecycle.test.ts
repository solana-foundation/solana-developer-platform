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
const pauseToken = vi.hoisted(() => vi.fn());
const unpauseToken = vi.hoisted(() => vi.fn());
const getTokenPauseState = vi.hoisted(() => vi.fn());
const getSlot = vi.hoisted(() => vi.fn());
// The stale mirror: it claims nothing is frozen, which is the post-failed-write state.
const isAccountFrozen = vi.hoisted(() => vi.fn());
const mirrorFreezeWrite = vi.hoisted(() => vi.fn());
const mirrorUnfreezeWrite = vi.hoisted(() => vi.fn());
const applySettledTokenStatus = vi.hoisted(() => vi.fn());
const reconcileObservedTokenPauseState = vi.hoisted(() => vi.fn());
const recordWorkflowTransaction = vi.hoisted(() => vi.fn());
// What the token row says about freeze support; the flag the API handler enforces.
const tokenRow = vi.hoisted(() => ({ isFreezable: true }));

vi.mock("@solana-program/token-2022", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@solana-program/token-2022")>()),
  fetchToken,
}));
vi.mock("@solana/mosaic-sdk", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@solana/mosaic-sdk")>()),
  getTokenPauseState,
}));
vi.mock("@sdp/rpc/solana", () => ({
  createRpcForSdk: () => ({ getSlot: () => ({ send: getSlot }) }),
}));
vi.mock("@/db", () => ({ getDb: () => ({}) }));
vi.mock("@/services/token.service", () => ({
  TokenService: class {
    isAccountFrozen = isAccountFrozen;
    freezeAccount = mirrorFreezeWrite;
    unfreezeAccount = mirrorUnfreezeWrite;
    applySettledTokenStatus = applySettledTokenStatus;
    reconcileObservedTokenPauseState = reconcileObservedTokenPauseState;
  },
}));
vi.mock("./record-transaction", () => ({ recordWorkflowTransaction }));

// prepareOnchain reaches custody and RPC; the signer/mosaic surface is all these actions
// use from it. resolveWalletTokenAccount is a live RPC derive, stubbed to a fixed account.
vi.mock("./onchain", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./onchain")>();
  return {
    ...actual,
    prepareOnchain: async () => ({
      ok: true,
      ctx: {
        token: tokenRow,
        mintAddress: TOKEN_ACCOUNT,
        signer: { address: WALLET },
        mosaic: { freezeAccount, thawAccount, pauseToken, unpauseToken },
      },
    }),
    resolveWalletTokenAccount: async () => TOKEN_ACCOUNT,
  };
});

import { MINT_ALREADY_PAUSED_ERROR, MINT_NOT_PAUSED_ERROR } from "@solana/mosaic-sdk";
import { runFreeze, runPause, runUnfreeze, runUnpause } from "./lifecycle";

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
    tokenRow.isFreezable = true;
    freezeAccount.mockResolvedValue({ signature: "sig_freeze", slot: 1 });
    thawAccount.mockResolvedValue({ signature: "sig_thaw", slot: 2 });
    mirrorFreezeWrite.mockResolvedValue(undefined);
    mirrorUnfreezeWrite.mockResolvedValue(undefined);
    recordWorkflowTransaction.mockResolvedValue("tx_ledger_1");
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

  // The API's freeze handler refuses a token declared not-freezable; a rule-driven
  // freeze is the same operation with a different trigger and must honor the same flag.
  it("refuses to freeze when the token does not support freeze operations", async () => {
    tokenRow.isFreezable = false;
    isAccountFrozen.mockResolvedValue(false);
    chainSays("thawed");

    const result = await runFreeze(env, executionFixture(), action);

    expect(freezeAccount).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      status: "failed",
      retryable: false,
      error: "TOKEN_NOT_FREEZABLE",
    });
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

// HOO-1013: the DB pause mirror must flow through applySettledTokenStatus —
// the ordered, once-only writer the manual admin path uses — anchored on the
// recorded transaction. A direct status write from the engine could land after
// a newer manual pause/unpause and silently reverse it.
describe("pause/unpause mirror status through the settled-transaction path", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    pauseToken.mockResolvedValue({ signature: "sig_pause", slot: 7 });
    unpauseToken.mockResolvedValue({ signature: "sig_unpause", slot: 8 });
    recordWorkflowTransaction.mockResolvedValue("tx_ledger_1");
    applySettledTokenStatus.mockResolvedValue(undefined);
    reconcileObservedTokenPauseState.mockResolvedValue(true);
    getSlot.mockResolvedValue(500n);
    getTokenPauseState.mockResolvedValue(true);
  });

  it("records the pause and applies the settled status against that transaction", async () => {
    const result = await runPause(env, executionFixture(), action);

    expect(pauseToken).toHaveBeenCalledTimes(1);
    expect(recordWorkflowTransaction).toHaveBeenCalledWith(
      env,
      expect.objectContaining({ id: "workflow_execution_lifecycle" }),
      expect.objectContaining({ type: "pause", signature: "sig_pause", slot: 7 })
    );
    expect(applySettledTokenStatus).toHaveBeenCalledWith("tx_ledger_1", "tok_1", "paused");
    expect(result.status).toBe("succeeded");
    expect(result.result).not.toMatchObject({ mirrorFailed: true });
  });

  it("records the unpause and applies the settled status against that transaction", async () => {
    const result = await runUnpause(env, executionFixture(), action);

    expect(applySettledTokenStatus).toHaveBeenCalledWith("tx_ledger_1", "tok_1", "active");
    expect(result.status).toBe("succeeded");
  });

  // A receipt without a slot cannot pass settled-status bookkeeping (which
  // refuses unordered confirmations), so the mirror comes from a slot-anchored
  // chain observation instead of being skipped.
  it("mirrors from a slot-anchored observation when the receipt has no slot", async () => {
    pauseToken.mockResolvedValue({ signature: "sig_pause_no_slot" });

    const result = await runPause(env, executionFixture(), action);

    expect(applySettledTokenStatus).not.toHaveBeenCalled();
    expect(reconcileObservedTokenPauseState).toHaveBeenCalledWith("tok_1", "paused", 500);
    expect(result.status).toBe("succeeded");
    expect(result.result).not.toMatchObject({ mirrorFailed: true });
  });

  // The converged mint may have been paused by an earlier tick whose ledger
  // write died — the DB must not stay `active` forever, so the branch repairs
  // from an observation rather than skipping.
  it("repairs the DB status from observation when the mint is already paused", async () => {
    pauseToken.mockRejectedValue(new Error(MINT_ALREADY_PAUSED_ERROR));

    const result = await runPause(env, executionFixture(), action);

    expect(result.status).toBe("succeeded");
    expect(result.result).toMatchObject({ alreadyPaused: true, statusRepaired: true });
    expect(reconcileObservedTokenPauseState).toHaveBeenCalledWith("tok_1", "paused", 500);
    expect(recordWorkflowTransaction).not.toHaveBeenCalled();
  });

  it("repairs the DB status from observation when the mint is already active", async () => {
    unpauseToken.mockRejectedValue(new Error(MINT_NOT_PAUSED_ERROR));
    getTokenPauseState.mockResolvedValue(false);

    const result = await runUnpause(env, executionFixture(), action);

    expect(result.status).toBe("succeeded");
    expect(result.result).toMatchObject({ alreadyActive: true, statusRepaired: true });
    expect(reconcileObservedTokenPauseState).toHaveBeenCalledWith("tok_1", "active", 500);
  });

  it("omits statusRepaired when the observation found nothing to repair", async () => {
    pauseToken.mockRejectedValue(new Error(MINT_ALREADY_PAUSED_ERROR));
    reconcileObservedTokenPauseState.mockResolvedValue(false);

    const result = await runPause(env, executionFixture(), action);

    expect(result.status).toBe("succeeded");
    expect(result.result).toMatchObject({ alreadyPaused: true });
    expect(result.result).not.toMatchObject({ statusRepaired: true });
  });

  // An unreadable observation must become a retry, never a success that
  // preserves a possibly-stale row.
  it("retries when the converge observation cannot be read", async () => {
    pauseToken.mockRejectedValue(new Error(MINT_ALREADY_PAUSED_ERROR));
    getTokenPauseState.mockRejectedValue(new Error("rpc timeout"));

    const result = await runPause(env, executionFixture(), action);

    expect(result.status).toBe("failed");
    expect(result.retryable).toBe(true);
    expect(reconcileObservedTokenPauseState).not.toHaveBeenCalled();
  });

  it("succeeds with mirrorFailed when the settled status write fails after the chain effect", async () => {
    applySettledTokenStatus.mockRejectedValue(new Error("db down"));

    const result = await runPause(env, executionFixture(), action);

    expect(result.status).toBe("succeeded");
    expect(result.result).toMatchObject({ mirrorFailed: true });
  });

  it("succeeds with ledgerFailed and no status write when the ledger write fails", async () => {
    recordWorkflowTransaction.mockResolvedValue(null);

    const result = await runPause(env, executionFixture(), action);

    expect(result.status).toBe("succeeded");
    expect(result.result).toMatchObject({ ledgerFailed: true, mirrorFailed: true });
    expect(applySettledTokenStatus).not.toHaveBeenCalled();
  });

  it("retries on other chain errors", async () => {
    pauseToken.mockRejectedValue(new Error("rpc timeout"));

    const result = await runPause(env, executionFixture(), action);

    expect(result.status).toBe("failed");
    expect(result.retryable).toBe(true);
    expect(recordWorkflowTransaction).not.toHaveBeenCalled();
  });
});
