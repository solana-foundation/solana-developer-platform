/**
 * Confidential-balance workflow actions.
 *
 * The HTTP handlers (`routes/issuance/handlers/confidential.ts`) and these share
 * the same MosaicService calls; what differs is how the signer is found. A rule
 * runs with no request context, so the holder's custody wallet is looked up from
 * the target public key rather than from an API key's wallet bindings.
 *
 * Devnet-only, like the routes: the guard lives here rather than in the dispatch
 * switch so a mainnet deployment cannot reach the chain through a rule either.
 */

import type {
  MosaicTransactionPlanResult,
  MosaicTransactionResult,
} from "@sdp/issuance/mosaic/types";
import { MosaicTransactionPlanError } from "@sdp/issuance/mosaic/types";
import type { Address } from "@sdp/solana/address";
import type { TokenTransactionType } from "@sdp/types";
import type { WorkflowExecutionRow } from "@/db/repositories";
import { resolveConfidentialTransferAuthority } from "@/routes/issuance/handlers/authority-resolution";
import { type ConfidentialKeys, withConfidentialKeys } from "@/services/issuance/confidential-keys";
import {
  planSignatureFields,
  summarizeConfidentialSettlement,
} from "@/services/issuance/confidential-plan";
import { tokenHasConfidentialBalances } from "@/services/issuance/confidential-support";
import { createMosaicService } from "@/services/issuance/mosaic";
import type { TokenService } from "@/services/token.service";
import type { Env } from "@/types/env";
import {
  errorMessage,
  permanentFail,
  prepareOnchain,
  resolveParam,
  resolveSignerForPublicKey,
  resolveTargetWallet,
  resolveWalletTokenAccount,
  safeAddress,
  succeeded,
  transientFail,
} from "./onchain";
import { recordWorkflowTransaction } from "./record-transaction";
import type { ActionContext, ActionExecutionResult } from "./types";

type MosaicService = ReturnType<typeof createMosaicService>;
type LoadedToken = NonNullable<Awaited<ReturnType<TokenService["getToken"]>>>;

interface HolderContext {
  token: LoadedToken;
  mintAddress: Address;
  owner: Address;
  tokenAccount: Address;
  walletId: string;
  mosaic: MosaicService;
}

function devnetOnly(env: Env): ActionExecutionResult | null {
  return (env.SOLANA_NETWORK ?? "devnet") === "devnet"
    ? null
    : permanentFail("CONFIDENTIAL_TRANSFERS_DEVNET_ONLY");
}

/**
 * Resolve the token, the target holder, its token account, and a MosaicService
 * signing as that holder. Every holder-signed confidential action starts here.
 */
async function prepareHolder(
  env: Env,
  execution: WorkflowExecutionRow,
  action: ActionContext
): Promise<{ ok: true; ctx: HolderContext } | { ok: false; result: ActionExecutionResult }> {
  // prepareOnchain loads and validates the token; its signer is the token's own
  // authority, which is not the one a holder-signed operation needs.
  const prep = await prepareOnchain(env, execution);
  if (!prep.ok) {
    return prep;
  }
  const { token, mintAddress } = prep.ctx;
  if (!tokenHasConfidentialBalances(token)) {
    return { ok: false, result: permanentFail("CONFIDENTIAL_NOT_ENABLED") };
  }

  const target = resolveTargetWallet(execution, action);
  if (!target) {
    return { ok: false, result: permanentFail("MISSING_TARGET_WALLET") };
  }
  const owner = safeAddress(target, "wallet");
  if (!owner) {
    return { ok: false, result: permanentFail("INVALID_TARGET_WALLET") };
  }

  const resolved = await resolveSignerForPublicKey(env, execution, owner);
  if (!resolved.ok) {
    return resolved;
  }

  const tokenAccount = await resolveWalletTokenAccount(env, owner, mintAddress);
  if (!tokenAccount) {
    return { ok: false, result: permanentFail("TOKEN_ACCOUNT_NOT_FOUND") };
  }

  return {
    ok: true,
    ctx: {
      token,
      mintAddress,
      owner,
      tokenAccount,
      walletId: resolved.walletId,
      mosaic: createMosaicService(env, resolved.signer, "sponsored"),
    },
  };
}

function withKeys<T>(
  env: Env,
  execution: WorkflowExecutionRow,
  ctx: HolderContext,
  use: (keys: ConfidentialKeys) => Promise<T>
): Promise<T> {
  return withConfidentialKeys(
    {
      env,
      organizationId: execution.organization_id,
      projectId: execution.project_id,
      walletId: ctx.walletId,
      owner: ctx.owner,
      mint: ctx.mintAddress,
    },
    use
  );
}

/**
 * Record the ledger row and build the success payload. Multi-transaction plans
 * report the last signature as the operation's own and list the rest, mirroring
 * how the HTTP handler settles them.
 */
async function confidentialSucceeded(
  env: Env,
  execution: WorkflowExecutionRow,
  result: MosaicTransactionResult | MosaicTransactionPlanResult,
  type: TokenTransactionType,
  params: Record<string, unknown>
): Promise<ActionExecutionResult> {
  const settlement = summarizeConfidentialSettlement(result);
  if (!settlement) {
    return transientFail("CONFIDENTIAL_PLAN_SUBMITTED_NOTHING");
  }
  const extra = planSignatureFields(settlement);

  const recorded = await recordWorkflowTransaction(env, execution, {
    type,
    params: { ...params, ...extra },
    signature: settlement.signature,
    slot: settlement.slot,
  });

  return succeeded({
    signature: settlement.signature,
    slot: String(settlement.slot),
    ...params,
    ...extra,
    ...(recorded ? {} : { ledgerFailed: true }),
  });
}

/**
 * A plan that failed partway already landed transactions that cannot be rolled
 * back, so it is never retried — a retry would build a second proof-context set
 * on top of the orphaned one. The landed signatures ride along in the error.
 */
function confidentialFailed(error: unknown): ActionExecutionResult {
  if (error instanceof MosaicTransactionPlanError) {
    const landed = error.submitted.map((entry) => entry.signature).join(",");
    return permanentFail(`CONFIDENTIAL_PLAN_PARTIAL:${errorMessage(error)}:${landed}`);
  }
  return transientFail(errorMessage(error));
}

// ═══════════════════════════════════════════════════════════════════════════
// Actions
// ═══════════════════════════════════════════════════════════════════════════

export async function runConfidentialConfigure(
  env: Env,
  execution: WorkflowExecutionRow,
  action: ActionContext
): Promise<ActionExecutionResult> {
  const blocked = devnetOnly(env);
  if (blocked) {
    return blocked;
  }
  const prep = await prepareHolder(env, execution, action);
  if (!prep.ok) {
    return prep.result;
  }
  const ctx = prep.ctx;

  try {
    const result = await withKeys(env, execution, ctx, (keys) =>
      ctx.mosaic.configureConfidentialAccount({
        mint: ctx.mintAddress,
        owner: ctx.owner,
        tokenAccount: ctx.tokenAccount,
        keys,
        feePayer: ctx.owner,
      })
    );
    return confidentialSucceeded(env, execution, result, "confidential_configure", {
      accountAddress: ctx.tokenAccount,
      walletAddress: ctx.owner,
    });
  } catch (error) {
    return confidentialFailed(error);
  }
}

export async function runConfidentialApprove(
  env: Env,
  execution: WorkflowExecutionRow,
  action: ActionContext
): Promise<ActionExecutionResult> {
  const blocked = devnetOnly(env);
  if (blocked) {
    return blocked;
  }
  // Approve is signed by the mint's confidential authority, not by the holder, so
  // it takes the token's own signer path and only the target is holder-derived.
  const prep = await prepareOnchain(env, execution);
  if (!prep.ok) {
    return prep.result;
  }
  const { token, mintAddress } = prep.ctx;
  if (!tokenHasConfidentialBalances(token)) {
    return permanentFail("CONFIDENTIAL_NOT_ENABLED");
  }

  const target = resolveTargetWallet(execution, action);
  const owner = target ? safeAddress(target, "wallet") : null;
  if (!owner) {
    return permanentFail(target ? "INVALID_TARGET_WALLET" : "MISSING_TARGET_WALLET");
  }

  let authority: string | null;
  try {
    authority = await resolveConfidentialTransferAuthority(env, token);
  } catch (error) {
    return transientFail(errorMessage(error));
  }
  if (!authority) {
    return permanentFail("CONFIDENTIAL_AUTHORITY_UNAVAILABLE");
  }
  const authorityAddress = safeAddress(authority, "authority");
  if (!authorityAddress) {
    return permanentFail("CONFIDENTIAL_AUTHORITY_UNAVAILABLE");
  }

  const resolved = await resolveSignerForPublicKey(env, execution, authorityAddress);
  if (!resolved.ok) {
    return resolved.result;
  }

  try {
    const tokenAccount = await resolveWalletTokenAccount(env, owner, mintAddress);
    if (!tokenAccount) {
      return permanentFail("TOKEN_ACCOUNT_NOT_FOUND");
    }
    const mosaic = createMosaicService(env, resolved.signer, "sponsored");
    const result = await mosaic.approveConfidentialAccount({
      tokenAccount,
      mint: mintAddress,
      authority: authorityAddress,
      feePayer: authorityAddress,
    });
    return confidentialSucceeded(env, execution, result, "confidential_approve", {
      accountAddress: tokenAccount,
      authority: authorityAddress,
    });
  } catch (error) {
    return confidentialFailed(error);
  }
}

export async function runConfidentialDeposit(
  env: Env,
  execution: WorkflowExecutionRow,
  action: ActionContext
): Promise<ActionExecutionResult> {
  const blocked = devnetOnly(env);
  if (blocked) {
    return blocked;
  }
  const amount = resolveParam(action, "amount");
  if (!amount) {
    return permanentFail("MISSING_AMOUNT");
  }
  const prep = await prepareHolder(env, execution, action);
  if (!prep.ok) {
    return prep.result;
  }
  const ctx = prep.ctx;

  try {
    // Deposit moves a publicly visible amount into the pending balance; no proof,
    // and therefore no keys.
    const result = await ctx.mosaic.depositConfidential({
      tokenAccount: ctx.tokenAccount,
      mint: ctx.mintAddress,
      amount,
      owner: ctx.owner,
      feePayer: ctx.owner,
    });
    return confidentialSucceeded(env, execution, result, "confidential_deposit", {
      accountAddress: ctx.tokenAccount,
      walletAddress: ctx.owner,
      amount,
    });
  } catch (error) {
    return confidentialFailed(error);
  }
}

export async function runConfidentialApplyPending(
  env: Env,
  execution: WorkflowExecutionRow,
  action: ActionContext
): Promise<ActionExecutionResult> {
  const blocked = devnetOnly(env);
  if (blocked) {
    return blocked;
  }
  const prep = await prepareHolder(env, execution, action);
  if (!prep.ok) {
    return prep.result;
  }
  const ctx = prep.ctx;

  try {
    const result = await withKeys(env, execution, ctx, (keys) =>
      ctx.mosaic.applyPendingConfidentialBalance({
        tokenAccount: ctx.tokenAccount,
        owner: ctx.owner,
        keys,
        feePayer: ctx.owner,
      })
    );
    return confidentialSucceeded(env, execution, result, "confidential_apply_pending", {
      accountAddress: ctx.tokenAccount,
      walletAddress: ctx.owner,
    });
  } catch (error) {
    return confidentialFailed(error);
  }
}

export async function runConfidentialTransfer(
  env: Env,
  execution: WorkflowExecutionRow,
  action: ActionContext
): Promise<ActionExecutionResult> {
  const blocked = devnetOnly(env);
  if (blocked) {
    return blocked;
  }
  const amount = resolveParam(action, "amount");
  if (!amount) {
    return permanentFail("MISSING_AMOUNT");
  }
  const destinationParam = resolveParam(action, "destination");
  if (!destinationParam) {
    return permanentFail("MISSING_DESTINATION");
  }
  const destinationWallet = safeAddress(destinationParam, "destination");
  if (!destinationWallet) {
    return permanentFail("INVALID_DESTINATION");
  }

  // The rule's `source` param names the sender; `resolveTargetWallet` reads
  // `wallet`, so map it across before resolving the holder.
  const source = resolveParam(action, "source");
  const holderAction: ActionContext = source
    ? { ...action, params: { ...action.params, wallet: source } }
    : action;

  const prep = await prepareHolder(env, execution, holderAction);
  if (!prep.ok) {
    return prep.result;
  }
  const ctx = prep.ctx;

  try {
    const destination = await resolveWalletTokenAccount(env, destinationWallet, ctx.mintAddress);
    if (!destination) {
      return permanentFail("DESTINATION_TOKEN_ACCOUNT_NOT_FOUND");
    }
    const result = await withKeys(env, execution, ctx, (keys) =>
      ctx.mosaic.confidentialTransfer({
        mint: ctx.mintAddress,
        from: ctx.tokenAccount,
        to: destination,
        amount,
        owner: ctx.owner,
        keys,
        feePayer: ctx.owner,
      })
    );
    return confidentialSucceeded(env, execution, result, "confidential_transfer", {
      source: ctx.tokenAccount,
      destination,
      walletAddress: ctx.owner,
      amount,
    });
  } catch (error) {
    return confidentialFailed(error);
  }
}

export async function runConfidentialWithdraw(
  env: Env,
  execution: WorkflowExecutionRow,
  action: ActionContext
): Promise<ActionExecutionResult> {
  const blocked = devnetOnly(env);
  if (blocked) {
    return blocked;
  }
  const amount = resolveParam(action, "amount");
  if (!amount) {
    return permanentFail("MISSING_AMOUNT");
  }
  const prep = await prepareHolder(env, execution, action);
  if (!prep.ok) {
    return prep.result;
  }
  const ctx = prep.ctx;

  try {
    const result = await withKeys(env, execution, ctx, (keys) =>
      ctx.mosaic.withdrawConfidential({
        tokenAccount: ctx.tokenAccount,
        mint: ctx.mintAddress,
        amount,
        owner: ctx.owner,
        keys,
        feePayer: ctx.owner,
      })
    );
    return confidentialSucceeded(env, execution, result, "confidential_withdraw", {
      accountAddress: ctx.tokenAccount,
      walletAddress: ctx.owner,
      amount,
    });
  } catch (error) {
    return confidentialFailed(error);
  }
}

export async function runConfidentialEmptyAccount(
  env: Env,
  execution: WorkflowExecutionRow,
  action: ActionContext
): Promise<ActionExecutionResult> {
  const blocked = devnetOnly(env);
  if (blocked) {
    return blocked;
  }
  const prep = await prepareHolder(env, execution, action);
  if (!prep.ok) {
    return prep.result;
  }
  const ctx = prep.ctx;

  try {
    const result = await withKeys(env, execution, ctx, (keys) =>
      ctx.mosaic.emptyConfidentialAccount({
        tokenAccount: ctx.tokenAccount,
        owner: ctx.owner,
        keys,
        feePayer: ctx.owner,
      })
    );
    return confidentialSucceeded(env, execution, result, "confidential_empty_account", {
      accountAddress: ctx.tokenAccount,
      walletAddress: ctx.owner,
    });
  } catch (error) {
    return confidentialFailed(error);
  }
}
