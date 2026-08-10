// Pre-flight checks for workflow-driven on-chain operations.
//
// The HTTP handlers run three gates before touching the chain: the supply/mintability
// check, the token's control list, and the wallet operation policy (amount and velocity
// limits, destination rules, custody approval). The workflow engine reaches the same
// mosaic primitives without any of them, which made a rule a way to mint past
// `maxSupply` or pay out to a control-list-blocked destination.
//
// The ordering matters as much as the checks: `updateSupply` used to run AFTER the mint
// landed and throw `MAX_SUPPLY_EXCEEDED` from there, which the caller then reported as a
// retryable failure — so the engine minted again. Everything here runs BEFORE the chain
// call, and a rejection is always permanent.

import type { Token } from "@sdp/types";
import { getDb } from "@/db";
import { createTenantScope } from "@/lib/tenant-scope";
import {
  assertDestinationAllowedByControlList,
  getOnChainAllowlistMutationForMint,
} from "@/routes/issuance/handlers/access-control";
import {
  enforceWalletOperationPolicy,
  resolvePolicyCustodyWallet,
} from "@/services/policy/enforcement.service";
import { TokenService } from "@/services/token.service";
import { resolveMintOperationAmount } from "@/services/token-operation.service";
import type { Env } from "@/types/env";
import type { OnchainContext } from "./onchain";
import { errorMessage, permanentFail } from "./onchain";
import type { ActionExecutionResult } from "./types";

// A rule's run is attributed to the workflow, not to a person: the human decision (if
// any) is recorded on the execution row and in the audit log at approval time.
function workflowActor(executionId: string) {
  return { type: "workflow" as const, id: executionId, workflowExecutionId: executionId };
}

export type PreflightOutcome = { ok: true } | { ok: false; result: ActionExecutionResult };

// Supply + mintability, using the same helper the HTTP mint route uses. Returns the
// base-unit amount so the caller doesn't parse twice.
export function preflightMintAmount(
  ctx: OnchainContext,
  amount: string
): { ok: true; mosaicAmount: number } | { ok: false; result: ActionExecutionResult } {
  try {
    const { mosaicAmount } = resolveMintOperationAmount(ctx.token as Token, amount);
    return { ok: true, mosaicAmount };
  } catch (error) {
    // Not mintable, not deployed, over max supply, unparseable amount — none self-heal.
    return { ok: false, result: permanentFail(errorMessage(error)) };
  }
}

// The token's allowlist/blocklist. `skipWhenListSynced` mirrors the HTTP mint route,
// which lets the mint flow add a fresh destination to the on-chain list itself; the
// seize route checks unconditionally, and so do we.
export async function preflightDestinationAllowed(
  env: Env,
  ctx: OnchainContext,
  destination: string,
  options: { skipWhenListSynced?: boolean } = {}
): Promise<PreflightOutcome> {
  const token = ctx.token as Token;
  if (options.skipWhenListSynced && getOnChainAllowlistMutationForMint(token)) {
    return { ok: true };
  }
  try {
    const isOnControlList = await new TokenService(getDb(env)).isAddressAllowed(
      token.id,
      destination
    );
    assertDestinationAllowedByControlList({ token, destination, isOnControlList });
    return { ok: true };
  } catch (error) {
    return { ok: false, result: permanentFail(errorMessage(error)) };
  }
}

// Wallet operation policy: amount/velocity limits, destination rules, custody approval.
// A policy denial is a deliberate "no", so it is permanent — retrying would just ask the
// same question again and burn the attempt budget.
export async function preflightWalletPolicy(
  env: Env,
  ctx: OnchainContext,
  input: {
    // burn/force_burn/seize have no HTTP policy gate to mirror (only mint and
    // update-authority do); their types exist so that wallet-baseline rules — which
    // match every operation when they name no operationTypes — bind the custody key
    // here too, and so orgs can write type-specific rules for them.
    operationType:
      | "issuance_mint_execute"
      | "issuance_update_authority_execute"
      | "issuance_burn_execute"
      | "issuance_force_burn_execute"
      | "issuance_seize_execute";
    amount?: string | null;
    destination?: string | null;
  }
): Promise<PreflightOutcome> {
  // The wallet that will actually sign, not the token's nominal `signingWalletId`. An
  // authority fallback can settle on a different custody wallet (rotated authority, or a
  // token that names no wallet at all), and binding the policy to the nominal one meant
  // the engine signed with wallet B while enforcing wallet A's limits — or enforcing
  // nothing, because the nominal id was null while the fallback had positively identified
  // a custody wallet to sign with.
  const walletId = ctx.signerWalletId;
  if (!walletId) {
    // No identified custody wallet — the org default signer. Same as the HTTP route,
    // which also skips the policy when it has no wallet id to bind it to.
    return { ok: true };
  }
  const auth = {
    organizationId: ctx.execution.organization_id,
    projectId: ctx.execution.project_id,
  };
  try {
    const policyWallet = await resolvePolicyCustodyWallet(
      env,
      auth as Parameters<typeof resolvePolicyCustodyWallet>[1],
      walletId
    );
    // The execution row's org/project are the trusted tenant identity here — they were
    // stamped at enqueue time from the authenticated rule, not from any payload.
    const scope = createTenantScope({
      organizationId: ctx.execution.organization_id,
      projectId: ctx.execution.project_id,
    });
    await enforceWalletOperationPolicy(env, scope, {
      organizationId: ctx.execution.organization_id,
      projectId: ctx.execution.project_id,
      custodyWalletId: policyWallet?.id ?? null,
      walletId,
      apiKeyId: null,
      actor: workflowActor(ctx.execution.id),
      operationFamily: "issuance",
      operationType: input.operationType,
      asset: ctx.token.symbol,
      amount: input.amount ?? null,
      destination: input.destination ?? null,
      context: {
        tokenId: ctx.token.id,
        tokenSymbol: ctx.token.symbol,
        mintAddress: ctx.token.mintAddress,
        workflowId: ctx.execution.workflow_id,
        workflowExecutionId: ctx.execution.id,
      },
      rawPayload: {
        tokenId: ctx.token.id,
        mintAddress: ctx.token.mintAddress,
        workflowExecutionId: ctx.execution.id,
      },
      idempotencyKey: ctx.execution.id,
    });
    return { ok: true };
  } catch (error) {
    return { ok: false, result: permanentFail(errorMessage(error)) };
  }
}
