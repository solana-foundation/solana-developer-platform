import type { TokenTransactionType } from "@sdp/types";
import { getDb } from "@/db";
import type { WorkflowExecutionRow } from "@/db/repositories";
import { AppError } from "@/lib/errors";
import { createTenantScope } from "@/lib/tenant-scope";
import { getLogger } from "@/runtime/logger";
import { createToken2022Service } from "@/services/solana";
import { TokenService } from "@/services/token.service";
import { parsePositiveTokenAmount } from "@/services/token-operation.service";
import type { Env } from "@/types/env";
import {
  errorMessage,
  permanentFail,
  prepareOnchain,
  resolveParam,
  resolveTargetWallet,
  resolveWalletTokenAccount,
  safeAddress,
  succeeded,
} from "./onchain";
import {
  preflightDestinationAllowed,
  preflightMintAmount,
  preflightWalletPolicy,
} from "./preflight";
import { recordWorkflowTransaction } from "./record-transaction";
import type { ActionContext, ActionExecutionResult } from "./types";

// The DB supply mirror for settled burns, best-effort AFTER the on-chain truth: a mirror
// write failure must never fail — let alone re-run — an action whose chain effect already
// landed. Surfaced via `mirrorFailed` in the result. Mints never come through here: they
// are counted atomically by `reserveMintSupply` before submission (see runMint), and
// mirroring one after the fact would count it twice.
async function mirrorSupply(
  env: Env,
  tokenId: string,
  amountStr: string,
  op: "burn"
): Promise<boolean> {
  try {
    await new TokenService(getDb(env)).updateSupply(tokenId, amountStr, op);
    return true;
  } catch (error) {
    getLogger().error(
      { tokenId, op, error: errorMessage(error) },
      "workflow supply: DB mirror failed"
    );
    return false;
  }
}

// Success payload for a landed chain call. Also writes the token_transactions row that
// puts a rule-driven op in the same Transactions/Activity view as a manual one.
async function supplySucceeded(
  env: Env,
  execution: WorkflowExecutionRow,
  result: { signature: string; slot: number | bigint },
  mirrored: boolean,
  ledger: { type: TokenTransactionType; params: Record<string, unknown> }
): Promise<ActionExecutionResult> {
  const recorded = await recordWorkflowTransaction(env, execution, {
    type: ledger.type,
    params: ledger.params,
    signature: result.signature,
    slot: result.slot,
  });
  return succeeded({
    signature: result.signature,
    slot: String(result.slot),
    ...(mirrored ? {} : { mirrorFailed: true }),
    ...(recorded ? {} : { ledgerFailed: true }),
  });
}

// Parse the rule's `amount` param into a base-unit (mosaic) amount for this token's
// decimals. Returns null on a missing/invalid amount so the caller fails permanently.
function parseAmount(
  action: ActionContext,
  decimals: number
): { amountStr: string; mosaicAmount: number; amountBaseUnits: bigint } | null {
  const amountStr = resolveParam(action, "amount");
  if (!amountStr) {
    return null;
  }
  try {
    const { mosaicAmount, amountBaseUnits } = parsePositiveTokenAmount(amountStr, decimals);
    return { amountStr, mosaicAmount, amountBaseUnits };
  } catch {
    return null;
  }
}

// mint → MosaicService.mintTo. Destination = target wallet, amount = rule param. Not
// idempotent (a retry would double-mint), so domain errors are permanent.
export async function runMint(
  env: Env,
  execution: WorkflowExecutionRow,
  action: ActionContext
): Promise<ActionExecutionResult> {
  const prep = await prepareOnchain(env, execution, "mint");
  if (!prep.ok) {
    return prep.result;
  }
  const { token, decimals, mintAddress, signer, mosaic } = prep.ctx;

  const destRaw = resolveTargetWallet(execution, action);
  if (!destRaw) {
    return permanentFail("MISSING_PARAM:wallet");
  }
  const destination = safeAddress(destRaw, "destination");
  if (!destination) {
    return permanentFail("INVALID_ADDRESS:wallet");
  }
  const amount = parseAmount(action, decimals);
  if (!amount) {
    return permanentFail("MISSING_OR_INVALID_PARAM:amount");
  }

  // Everything the HTTP mint route checks, checked here too and BEFORE the chain call:
  // mintability + max supply, the token's control list, and the wallet policy. Running
  // the supply check after the mint is what allowed a rule to mint past `maxSupply`.
  const supplyCheck = preflightMintAmount(prep.ctx, amount.amountStr);
  if (!supplyCheck.ok) {
    return supplyCheck.result;
  }
  const allowed = await preflightDestinationAllowed(env, prep.ctx, destination);
  if (!allowed.ok) {
    return allowed.result;
  }
  const policy = await preflightWalletPolicy(env, prep.ctx, {
    operationType: "issuance_mint_execute",
    amount: amount.amountStr,
    destination,
  });
  if (!policy.ok) {
    return policy.result;
  }

  // The preflight above checked a supply snapshot loaded at prepareOnchain time; two
  // concurrent mints (rule + rule, or rule + HTTP) both pass it and both land past
  // `maxSupply`. The cap is ENFORCED here instead, the same way the HTTP execute route
  // enforces it: `reserveMintSupply` is an atomic conditional UPDATE contending on the
  // token row, run at the last moment before submission, so the second contender sees
  // the first's count and is refused before its transaction leaves SDP.
  //
  // The reservation IS the count (see reserveMintSupply): nothing is added when the
  // mint settles, and nothing is handed back when a post-submit failure is ambiguous —
  // the transaction may still land. `POST /supply/refresh` reconciles from the mint
  // account either way.
  //
  // Destructive + not idempotent: a blind retry could double-mint (we cannot know
  // whether a failed submit landed). Any chain error is permanent — a human inspects
  // and explicitly re-approves via Retry.
  let reservedSupply: string | null = null;
  let result: Awaited<ReturnType<typeof mosaic.mintTo>>;
  try {
    result = await mosaic.mintTo(
      {
        mint: mintAddress,
        destination,
        amount: amount.mosaicAmount,
        mintAuthority: signer.address,
        feePayer: signer.address,
      },
      async () => {
        // The execution row's org/project are the trusted tenant identity (stamped at
        // enqueue time from the authenticated rule), scoping the reservation exactly as
        // the HTTP route's request scope does.
        const tokenService = new TokenService(
          getDb(env),
          createTenantScope({
            organizationId: execution.organization_id,
            projectId: execution.project_id,
          })
        );
        reservedSupply = await tokenService.reserveMintSupply(
          token.id,
          amount.amountBaseUnits.toString()
        );
        if (reservedSupply === null) {
          throw new AppError("MAX_SUPPLY_EXCEEDED", "Mint amount would exceed maximum supply");
        }
      }
    );
  } catch (error) {
    if (reservedSupply !== null) {
      getLogger().warn(
        {
          event: "mint_supply_reservation_retained",
          tokenId: token.id,
          workflowExecutionId: execution.id,
          reservedBaseUnits: amount.amountBaseUnits.toString(),
          recordedSupplyBaseUnits: reservedSupply,
          error: errorMessage(error),
        },
        "Workflow mint failed after it was submitted and its supply reserved; the reservation is kept because the transaction may still land. Refresh the token's supply to reconcile."
      );
    }
    return permanentFail(errorMessage(error));
  }
  return supplySucceeded(env, execution, result, true, {
    type: "mint",
    params: { destination, amount: amount.amountStr },
  });
}

// burn → Token2022Service.burn from the org signer's own token account (self-burn).
// To burn a holder's balance use force_burn (permanent delegate) instead.
export async function runBurn(
  env: Env,
  execution: WorkflowExecutionRow,
  action: ActionContext
): Promise<ActionExecutionResult> {
  const prep = await prepareOnchain(env, execution);
  if (!prep.ok) {
    return prep.result;
  }
  const { token, decimals, mintAddress, signer } = prep.ctx;

  const amount = parseAmount(action, decimals);
  if (!amount) {
    return permanentFail("MISSING_OR_INVALID_PARAM:amount");
  }

  // The signing wallet's operation policy (amount/velocity limits, custody approval)
  // binds every custody-signed op, checked BEFORE the chain call — a rule must not be
  // a way to destroy supply past limits the org configured for the key.
  const policy = await preflightWalletPolicy(env, prep.ctx, {
    operationType: "issuance_burn_execute",
    amount: amount.amountStr,
  });
  if (!policy.ok) {
    return policy.result;
  }

  // Destructive + not idempotent: any chain error is permanent (see runMint).
  let result: Awaited<ReturnType<ReturnType<typeof createToken2022Service>["burn"]>>;
  try {
    const source = await resolveWalletTokenAccount(env, signer.address, mintAddress);
    const token2022 = createToken2022Service(env, signer);
    result = await token2022.burn({
      mint: mintAddress,
      source,
      amount: amount.mosaicAmount,
      authority: signer,
    });
  } catch (error) {
    return permanentFail(errorMessage(error));
  }
  const mirrored = await mirrorSupply(env, token.id, amount.amountStr, "burn");
  return supplySucceeded(env, execution, result, mirrored, {
    type: "burn",
    params: { amount: amount.amountStr },
  });
}

// force_burn → MosaicService.forceBurn from a holder's wallet via permanent delegate.
// Source = explicit `source` param or the trigger's subject wallet.
export async function runForceBurn(
  env: Env,
  execution: WorkflowExecutionRow,
  action: ActionContext
): Promise<ActionExecutionResult> {
  const prep = await prepareOnchain(env, execution);
  if (!prep.ok) {
    return prep.result;
  }
  const { token, decimals, mintAddress, signer, mosaic } = prep.ctx;

  const sourceRaw = resolveParam(action, "source") ?? resolveTargetWallet(execution, action);
  if (!sourceRaw) {
    return permanentFail("MISSING_PARAM:source");
  }
  const source = safeAddress(sourceRaw, "source");
  if (!source) {
    return permanentFail("INVALID_ADDRESS:source");
  }
  const amount = parseAmount(action, decimals);
  if (!amount) {
    return permanentFail("MISSING_OR_INVALID_PARAM:amount");
  }

  // Wallet policy for the permanent-delegate key, BEFORE the chain call (see runBurn).
  const policy = await preflightWalletPolicy(env, prep.ctx, {
    operationType: "issuance_force_burn_execute",
    amount: amount.amountStr,
  });
  if (!policy.ok) {
    return policy.result;
  }

  // Destructive + not idempotent: any chain error is permanent (see runMint).
  let result: Awaited<ReturnType<typeof mosaic.forceBurn>>;
  try {
    result = await mosaic.forceBurn({
      mint: mintAddress,
      source,
      amount: amount.mosaicAmount,
      permanentDelegate: signer,
      feePayer: signer,
    });
  } catch (error) {
    return permanentFail(errorMessage(error));
  }
  const mirrored = await mirrorSupply(env, token.id, amount.amountStr, "burn");
  return supplySucceeded(env, execution, result, mirrored, {
    type: "force_burn",
    params: { source, amount: amount.amountStr },
  });
}

// seize → MosaicService.forceTransfer from a holder's wallet to a destination via the
// permanent delegate. Source = `source` param or the trigger wallet; destination is a
// required param (e.g. the issuer treasury).
export async function runSeize(
  env: Env,
  execution: WorkflowExecutionRow,
  action: ActionContext
): Promise<ActionExecutionResult> {
  const prep = await prepareOnchain(env, execution);
  if (!prep.ok) {
    return prep.result;
  }
  const { decimals, mintAddress, signer, mosaic } = prep.ctx;

  const sourceRaw = resolveParam(action, "source") ?? resolveTargetWallet(execution, action);
  if (!sourceRaw) {
    return permanentFail("MISSING_PARAM:source");
  }
  const destRaw = resolveParam(action, "destination");
  if (!destRaw) {
    return permanentFail("MISSING_PARAM:destination");
  }
  const source = safeAddress(sourceRaw, "source");
  const destination = safeAddress(destRaw, "destination");
  if (!source || !destination) {
    return permanentFail("INVALID_ADDRESS:source_or_destination");
  }
  const amount = parseAmount(action, decimals);
  if (!amount) {
    return permanentFail("MISSING_OR_INVALID_PARAM:amount");
  }

  // The HTTP seize route checks the destination against the token's control list before
  // moving anything; a rule that seizes into a blocklisted wallet must fail the same way.
  const allowed = await preflightDestinationAllowed(env, prep.ctx, destination);
  if (!allowed.ok) {
    return allowed.result;
  }

  // Wallet policy for the permanent-delegate key, BEFORE the chain call (see runBurn).
  // Seize moves value, so its destination is subject to the policy's destination rules.
  const policy = await preflightWalletPolicy(env, prep.ctx, {
    operationType: "issuance_seize_execute",
    amount: amount.amountStr,
    destination,
  });
  if (!policy.ok) {
    return policy.result;
  }

  // Destructive + not idempotent: any chain error is permanent (see runMint).
  try {
    const result = await mosaic.forceTransfer({
      mint: mintAddress,
      source,
      destination,
      amount: amount.mosaicAmount,
      permanentDelegate: signer,
      feePayer: signer,
    });
    const recorded = await recordWorkflowTransaction(env, execution, {
      type: "seize",
      params: { source, destination, amount: amount.amountStr },
      signature: result.signature,
      slot: result.slot,
    });
    return succeeded({
      signature: result.signature,
      slot: String(result.slot),
      ...(recorded ? {} : { ledgerFailed: true }),
    });
  } catch (error) {
    return permanentFail(errorMessage(error));
  }
}
