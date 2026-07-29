import { getDb } from "@/db";
import type { WorkflowExecutionRow } from "@/db/repositories";
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
  transientFail,
} from "./onchain";
import type { ActionContext, ActionExecutionResult } from "./types";

// Parse the rule's `amount` param into a base-unit (mosaic) amount for this token's
// decimals. Returns null on a missing/invalid amount so the caller fails permanently.
function parseAmount(
  action: ActionContext,
  decimals: number
): { amountStr: string; mosaicAmount: number } | null {
  const amountStr = resolveParam(action, "amount");
  if (!amountStr) {
    return null;
  }
  try {
    const { mosaicAmount } = parsePositiveTokenAmount(amountStr, decimals);
    return { amountStr, mosaicAmount };
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
  const prep = await prepareOnchain(env, execution);
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

  try {
    const result = await mosaic.mintTo({
      mint: mintAddress,
      destination,
      amount: amount.mosaicAmount,
      mintAuthority: signer.address,
      feePayer: signer.address,
    });
    await new TokenService(getDb(env)).updateSupply(token.id, amount.amountStr, "mint");
    return succeeded({ signature: result.signature, slot: String(result.slot) });
  } catch (error) {
    return transientFail(errorMessage(error));
  }
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

  try {
    const source = await resolveWalletTokenAccount(env, signer.address, mintAddress);
    const token2022 = createToken2022Service(env, signer);
    const result = await token2022.burn({
      mint: mintAddress,
      source,
      amount: amount.mosaicAmount,
      authority: signer,
    });
    await new TokenService(getDb(env)).updateSupply(token.id, amount.amountStr, "burn");
    return succeeded({ signature: result.signature, slot: String(result.slot) });
  } catch (error) {
    return transientFail(errorMessage(error));
  }
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

  try {
    const result = await mosaic.forceBurn({
      mint: mintAddress,
      source,
      amount: amount.mosaicAmount,
      permanentDelegate: signer,
      feePayer: signer,
    });
    await new TokenService(getDb(env)).updateSupply(token.id, amount.amountStr, "burn");
    return succeeded({ signature: result.signature, slot: String(result.slot) });
  } catch (error) {
    return transientFail(errorMessage(error));
  }
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

  try {
    const result = await mosaic.forceTransfer({
      mint: mintAddress,
      source,
      destination,
      amount: amount.mosaicAmount,
      permanentDelegate: signer,
      feePayer: signer,
    });
    return succeeded({ signature: result.signature, slot: String(result.slot) });
  } catch (error) {
    return transientFail(errorMessage(error));
  }
}
