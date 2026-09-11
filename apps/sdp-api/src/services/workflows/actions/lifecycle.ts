import { createRpcForSdk } from "@sdp/rpc/solana";
import type { Address } from "@sdp/solana/address";
import type { TokenTransactionType } from "@sdp/types";
import {
  getTokenPauseState,
  MINT_ALREADY_PAUSED_ERROR,
  MINT_NOT_PAUSED_ERROR,
} from "@solana/mosaic-sdk";
import { AccountState, fetchToken } from "@solana-program/token-2022";
import { getDb } from "@/db";
import type { WorkflowExecutionRow } from "@/db/repositories";
import { createTenantScope } from "@/lib/tenant-scope";
import { getLogger } from "@/runtime/logger";
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

function tenantTokenService(env: Env, execution: WorkflowExecutionRow): TokenService {
  return new TokenService(
    getDb(env),
    createTenantScope({
      organizationId: execution.organization_id,
      projectId: execution.project_id,
    })
  );
}

// Mirror the OBSERVED on-chain pause state into `issued_tokens.status`,
// anchored to a slot so a newer settled transition always wins the write (the
// veto lives in reconcileObservedTokenPauseState). The slot is read BEFORE the
// state: understating the anchor means a transition landing between the two
// reads gets recorded with a higher slot and vetoes this write, instead of
// being silently overwritten. Returns whether a repair write happened.
async function mirrorObservedPauseState(
  env: Env,
  execution: WorkflowExecutionRow,
  mint: Address
): Promise<boolean> {
  const rpc = createRpcForSdk<Parameters<typeof getTokenPauseState>[0]>(env);
  const observedAtSlot = Number(await rpc.getSlot({ commitment: "confirmed" }).send());
  const paused = await getTokenPauseState(rpc, mint);
  return tenantTokenService(env, execution).reconcileObservedTokenPauseState(
    execution.token_id,
    paused ? "paused" : "active",
    observedAtSlot
  );
}

// The DB pause mirror goes through applySettledTokenStatus — the same ordered,
// once-only writer the manual admin pause path uses — anchored on the recorded
// transaction's slot. Writing `issued_tokens.status` directly from here let a
// slow rule tick land after a newer manual pause/unpause and silently reverse
// it (HOO-1013). A receipt without a slot cannot pass that bookkeeping, so it
// falls back to a slot-anchored observation of the chain instead. A mirror
// failure never fails the action: the chain effect has already landed, so it
// is reported as `mirrorFailed` like the freeze mirror.
async function lifecycleStatusSucceeded(
  env: Env,
  execution: WorkflowExecutionRow,
  mint: Address,
  result: { signature: string; slot?: number | bigint },
  type: "pause" | "unpause",
  status: "paused" | "active"
): Promise<ActionExecutionResult> {
  const transactionId = await recordWorkflowTransaction(env, execution, {
    type,
    params: {},
    signature: result.signature,
    slot: result.slot ?? null,
  });
  let mirrored = false;
  if (transactionId) {
    try {
      if (result.slot == null) {
        await mirrorObservedPauseState(env, execution, mint);
      } else {
        await tenantTokenService(env, execution).applySettledTokenStatus(
          transactionId,
          execution.token_id,
          status
        );
      }
      mirrored = true;
    } catch (error) {
      getLogger().error(
        { executionId: execution.id, type, error: errorMessage(error) },
        "workflow lifecycle: settled status mirror failed"
      );
    }
  }
  return succeeded({
    signature: result.signature,
    ...(result.slot == null ? {} : { slot: String(result.slot) }),
    ...(mirrored ? {} : { mirrorFailed: true }),
    ...(transactionId ? {} : { ledgerFailed: true }),
  });
}

// A converged mint holds no settled transaction of our own to order a status
// write against — the transition that converged it may even predate this rule,
// with its ledger write lost (crash between chain effect and bookkeeping). So
// repair from a slot-anchored observation rather than skipping: the DB must
// not stay `active` forever over a mint that is paused on chain. An unreadable
// observation becomes a retry, never a success over a possibly-stale row.
async function convergedLifecycleSucceeded(
  env: Env,
  execution: WorkflowExecutionRow,
  mint: Address,
  flag: Record<string, unknown>
): Promise<ActionExecutionResult> {
  try {
    const repaired = await mirrorObservedPauseState(env, execution, mint);
    return succeeded({ ...flag, ...(repaired ? { statusRepaired: true } : {}) });
  } catch (error) {
    return transientFail(errorMessage(error));
  }
}

// pause → MosaicService.pauseToken. Idempotent: an already-paused mint is a
// converged success, with the DB status reconciled from a slot-anchored
// observation (see convergedLifecycleSucceeded).
export async function runPause(
  env: Env,
  execution: WorkflowExecutionRow,
  _action: ActionContext
): Promise<ActionExecutionResult> {
  const prep = await prepareOnchain(env, execution);
  if (!prep.ok) {
    return prep.result;
  }
  const { mintAddress, signer, mosaic } = prep.ctx;

  try {
    const result = await mosaic.pauseToken({
      mint: mintAddress,
      pauseAuthority: signer,
      feePayer: signer,
    });
    return lifecycleStatusSucceeded(env, execution, mintAddress, result, "pause", "paused");
  } catch (error) {
    if (error instanceof Error && error.message === MINT_ALREADY_PAUSED_ERROR) {
      return convergedLifecycleSucceeded(env, execution, mintAddress, { alreadyPaused: true });
    }
    return transientFail(errorMessage(error));
  }
}

// unpause → MosaicService.unpauseToken. Idempotent: an already-active mint
// succeeds (see runPause).
export async function runUnpause(
  env: Env,
  execution: WorkflowExecutionRow,
  _action: ActionContext
): Promise<ActionExecutionResult> {
  const prep = await prepareOnchain(env, execution);
  if (!prep.ok) {
    return prep.result;
  }
  const { mintAddress, signer, mosaic } = prep.ctx;

  try {
    const result = await mosaic.unpauseToken({
      mint: mintAddress,
      pauseAuthority: signer,
      feePayer: signer,
    });
    return lifecycleStatusSucceeded(env, execution, mintAddress, result, "unpause", "active");
  } catch (error) {
    if (error instanceof Error && error.message === MINT_NOT_PAUSED_ERROR) {
      return convergedLifecycleSucceeded(env, execution, mintAddress, { alreadyActive: true });
    }
    return transientFail(errorMessage(error));
  }
}

// Whether the token account is frozen ON CHAIN.
//
// The frozen_accounts table cannot answer this. It records what the platform froze, and
// it is written best-effort AFTER the chain op — so "no row" means "we have no record",
// never "the account is thawed". Gating on it turned a single failed mirror write into a
// permanent silent no-op: the account stayed frozen on chain while the rule reported
// alreadyThawed and the engine marked the execution succeeded. The converse stranded a
// freeze the same way. Callers run this inside their try, so an RPC error becomes a retry
// rather than a wrong answer.
async function isFrozenOnChain(env: Env, tokenAccount: Address): Promise<boolean> {
  const rpc = createRpcForSdk<Parameters<typeof fetchToken>[0]>(env);
  const account = await fetchToken(rpc, tokenAccount);
  return account.data.state === AccountState.Frozen;
}

// The DB frozen-account mirror is bookkeeping written AFTER the on-chain truth: a mirror
// write failure must not fail an action whose chain effect already landed. It is reported
// via `mirrorFailed` and never used to decide whether the chain op is needed.
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
    getLogger().error({ error: errorMessage(error) }, "workflow freeze: DB mirror failed");
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
    getLogger().error({ error: errorMessage(error) }, "workflow unfreeze: DB mirror failed");
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

  // The same flag the direct freeze endpoint enforces: a rule-driven freeze is
  // that operation with a different trigger, not an exemption from it.
  if (!prep.ctx.token.isFreezable) {
    return permanentFail("TOKEN_NOT_FREEZABLE");
  }

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
    // Idempotent converge against chain state, so a retry after a partial success (chain
    // landed, tick died) does not re-submit and fail on the raw chain error.
    if (await isFrozenOnChain(env, tokenAccount)) {
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
    // Idempotent converge (see runFreeze): not frozen on chain → nothing to thaw.
    if (!(await isFrozenOnChain(env, tokenAccount))) {
      return succeeded({ alreadyThawed: true, tokenAccount });
    }
    const result = await mosaic.thawAccount({ tokenAccount, feePayer: signer.address });
    const mirrored = await mirrorUnfreeze(env, execution, tokenAccount);
    return lifecycleSucceeded(env, execution, result, "unfreeze", { tokenAccount }, mirrored);
  } catch (error) {
    return transientFail(errorMessage(error));
  }
}
