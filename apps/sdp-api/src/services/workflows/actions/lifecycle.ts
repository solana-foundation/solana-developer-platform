import type { TokenTransactionType } from "@sdp/types";
import { MINT_ALREADY_PAUSED_ERROR, MINT_NOT_PAUSED_ERROR } from "@solana/mosaic-sdk";
import { getDb } from "@/db";
import type { WorkflowExecutionRow } from "@/db/repositories";
import { TokenService } from "@/services/token.service";
import type { Env } from "@/types/env";
import { humanizeWorkflowKey } from "../labels";
import {
  errorMessage,
  permanentFail,
  prepareOnchain,
  resolveTargetWallet,
  resolveWalletTokenAccount,
  safeAddress,
  succeeded,
  transientFail,
} from "./onchain";
import { recordWorkflowTransaction } from "./record-transaction";
import type { ActionContext, ActionExecutionResult } from "./types";

// Success payload for a landed lifecycle op, plus the token_transactions row that puts a
// rule-driven pause/freeze in the same Transactions/Activity view as a manual one.
async function lifecycleSucceeded(
  env: Env,
  execution: WorkflowExecutionRow,
  result: { signature: string; slot?: number | bigint },
  type: TokenTransactionType,
  params: Record<string, unknown>,
  mirrored = true
): Promise<ActionExecutionResult> {
  const recorded = await recordWorkflowTransaction(env, execution, {
    type,
    params,
    signature: result.signature,
    slot: result.slot ?? null,
  });
  return succeeded({
    signature: result.signature,
    ...(result.slot == null ? {} : { slot: String(result.slot) }),
    ...params,
    ...(mirrored ? {} : { mirrorFailed: true }),
    ...(recorded ? {} : { ledgerFailed: true }),
  });
}

// pause → MosaicService.pauseToken. Idempotent: an already-paused mint is a converged
// success (the DB status is reconciled either way).
export async function runPause(
  env: Env,
  execution: WorkflowExecutionRow,
  _action: ActionContext
): Promise<ActionExecutionResult> {
  const prep = await prepareOnchain(env, execution);
  if (!prep.ok) {
    return prep.result;
  }
  const { token, mintAddress, signer, mosaic } = prep.ctx;
  const tokenService = new TokenService(getDb(env));

  try {
    const result = await mosaic.pauseToken({
      mint: mintAddress,
      pauseAuthority: signer,
      feePayer: signer,
    });
    await tokenService.updateToken(token.id, { status: "paused" });
    return lifecycleSucceeded(env, execution, result, "pause", {});
  } catch (error) {
    if (error instanceof Error && error.message === MINT_ALREADY_PAUSED_ERROR) {
      await tokenService.updateToken(token.id, { status: "paused" });
      return succeeded({ alreadyPaused: true });
    }
    return transientFail(errorMessage(error));
  }
}

// unpause → MosaicService.unpauseToken. Idempotent: an already-active mint succeeds.
export async function runUnpause(
  env: Env,
  execution: WorkflowExecutionRow,
  _action: ActionContext
): Promise<ActionExecutionResult> {
  const prep = await prepareOnchain(env, execution);
  if (!prep.ok) {
    return prep.result;
  }
  const { token, mintAddress, signer, mosaic } = prep.ctx;
  const tokenService = new TokenService(getDb(env));

  try {
    const result = await mosaic.unpauseToken({
      mint: mintAddress,
      pauseAuthority: signer,
      feePayer: signer,
    });
    await tokenService.updateToken(token.id, { status: "active" });
    return lifecycleSucceeded(env, execution, result, "unpause", {});
  } catch (error) {
    if (error instanceof Error && error.message === MINT_NOT_PAUSED_ERROR) {
      await tokenService.updateToken(token.id, { status: "active" });
      return succeeded({ alreadyActive: true });
    }
    return transientFail(errorMessage(error));
  }
}

// The DB frozen-account mirror is best-effort AFTER the on-chain truth: a mirror write
// failure must not fail an action whose chain effect already landed (a retry would hit
// ACCOUNT_ALREADY_FROZEN and converge anyway).
async function mirrorFreeze(
  env: Env,
  execution: WorkflowExecutionRow,
  tokenAccount: string
): Promise<boolean> {
  try {
    await new TokenService(getDb(env)).freezeAccount({
      tokenId: execution.token_id,
      accountAddress: tokenAccount,
      frozenBy: `workflow:${execution.workflow_id}`,
      reason: `Workflow: ${humanizeWorkflowKey(execution.trigger_type)}`,
    });
    return true;
  } catch (error) {
    console.error("workflow freeze: DB mirror failed", { error: errorMessage(error) });
    return false;
  }
}

async function mirrorUnfreeze(
  env: Env,
  execution: WorkflowExecutionRow,
  tokenAccount: string
): Promise<boolean> {
  try {
    await new TokenService(getDb(env)).unfreezeAccount(
      execution.token_id,
      tokenAccount,
      `workflow:${execution.workflow_id}`
    );
    return true;
  } catch (error) {
    console.error("workflow unfreeze: DB mirror failed", { error: errorMessage(error) });
    return false;
  }
}

// freeze → MosaicService.freezeAccount on the target wallet's token account. Idempotent:
// an already-frozen account is success.
export async function runFreeze(
  env: Env,
  execution: WorkflowExecutionRow,
  action: ActionContext
): Promise<ActionExecutionResult> {
  const prep = await prepareOnchain(env, execution, "freeze");
  if (!prep.ok) {
    return prep.result;
  }
  const { mintAddress, signer, mosaic } = prep.ctx;

  const targetRaw = resolveTargetWallet(execution, action);
  if (!targetRaw) {
    return permanentFail("MISSING_PARAM:wallet");
  }
  const wallet = safeAddress(targetRaw, "wallet");
  if (!wallet) {
    return permanentFail("INVALID_ADDRESS:wallet");
  }

  try {
    const tokenAccount = await resolveWalletTokenAccount(env, wallet, mintAddress);
    // Idempotent converge: the platform's frozen-accounts mirror is the authority on
    // what it froze — a retry after a partial success (chain landed, tick died) must
    // not re-submit and fail on the raw chain error.
    if (await new TokenService(getDb(env)).isAccountFrozen(execution.token_id, tokenAccount)) {
      return succeeded({ alreadyFrozen: true, tokenAccount });
    }
    const result = await mosaic.freezeAccount({ tokenAccount, feePayer: signer.address });
    const mirrored = await mirrorFreeze(env, execution, tokenAccount);
    return lifecycleSucceeded(env, execution, result, "freeze", { tokenAccount }, mirrored);
  } catch (error) {
    return transientFail(errorMessage(error));
  }
}

// unfreeze → MosaicService.thawAccount on the target wallet's token account. Idempotent:
// an already-thawed account is success.
export async function runUnfreeze(
  env: Env,
  execution: WorkflowExecutionRow,
  action: ActionContext
): Promise<ActionExecutionResult> {
  const prep = await prepareOnchain(env, execution, "freeze");
  if (!prep.ok) {
    return prep.result;
  }
  const { mintAddress, signer, mosaic } = prep.ctx;

  const targetRaw = resolveTargetWallet(execution, action);
  if (!targetRaw) {
    return permanentFail("MISSING_PARAM:wallet");
  }
  const wallet = safeAddress(targetRaw, "wallet");
  if (!wallet) {
    return permanentFail("INVALID_ADDRESS:wallet");
  }

  try {
    const tokenAccount = await resolveWalletTokenAccount(env, wallet, mintAddress);
    // Idempotent converge (see runFreeze): not frozen in the mirror → nothing to thaw.
    if (!(await new TokenService(getDb(env)).isAccountFrozen(execution.token_id, tokenAccount))) {
      return succeeded({ alreadyThawed: true, tokenAccount });
    }
    const result = await mosaic.thawAccount({ tokenAccount, feePayer: signer.address });
    const mirrored = await mirrorUnfreeze(env, execution, tokenAccount);
    return lifecycleSucceeded(env, execution, result, "unfreeze", { tokenAccount }, mirrored);
  } catch (error) {
    return transientFail(errorMessage(error));
  }
}
