/**
 * Wallet-policy gating for DvP money movement (PRO-1975).
 *
 * Until now no DvP action went through `policyGate`, so an amount or asset rule
 * on a custody wallet did not apply to a trade. Two of the four actions are now
 * gated, and the other two deliberately are not.
 *
 * **Gated: fund and settle.** They are the actions that COMMIT value. Funding
 * moves a custody wallet's tokens into an escrow only settle, cancel or reclaim
 * can get back; settling delivers both legs irreversibly.
 *
 * **Not gated: reclaim and cancel.** They are the RECOVERY paths, and gating
 * them can strand a deposit. `packages/sdp-policy/src/evaluate.ts` falls back to
 * the profile's `defaultAction` when no rule matches, so the moment a candidate
 * exists for them, an organization defaulting to `approval_required` has its
 * escrow exits queued behind an approver. That is the case ADR 0002 rules out
 * and PRO-1958 states as an invariant: no policy rule may trap funds. Leaving
 * the two recovery paths ungoverned is what keeps a gated settle safe, because a
 * settle whose approval arrives after the trade expires can always be unwound.
 *
 * `dvp_reclaim` is therefore NOT added as an operation type. Declaring one with
 * no call site is the state the audit flagged in the first place.
 *
 * **Family.** Both use `program`, which is what Earn's vault and program
 * movements use (`routes/earn/handlers/vault.ts:520`) and the same shape: a
 * custody wallet signing an on-chain program interaction. This means an
 * organization's existing `program`-family rule starts governing DvP as well,
 * which is a deliberate widening in the fail-safe direction and is called out in
 * the PR. A dedicated `dvp` family belongs with the wider policy rework
 * (PRO-1597), where the authoring UI can be updated with it.
 */

import type { PolicyCandidate, WalletOperationType } from "@sdp/types";
import type { Context } from "hono";
import { getDb } from "@/db";
import type { DvpTradeRow } from "@/db/repositories";
import { type ApiKeyContext, getAuth } from "@/lib/auth";
import { conflict, internalError } from "@/lib/errors";
import { IDEMPOTENCY_KEY_HEADER } from "@/middleware/idempotency-key";
import { getPolicyGateContext, type PolicyGateExtraction } from "@/middleware/policy-gate";
import type { ValidatedBodyContext } from "@/middleware/validate";
import { CustodyRuntimeTargets } from "@/services/domain/signing/custody-runtime-target";
import { walletOperationActorFromAuth } from "@/services/policy/enforcement.service";
import type { Env } from "@/types/env";
import { resolveCloseAction, resolveLegAction } from "./action-context";
import type { fundDvpTradeSchema } from "./schemas";

type DvpPolicyOperationType = Extract<WalletOperationType, "dvp_fund" | "dvp_settle">;

/**
 * Refuse a custody wallet the gate did not judge. The handler resolves its
 * signer a second time, and if the custody lookup moved in between it would
 * execute under a policy nobody evaluated.
 *
 * The issuance twin is `routes/issuance/handlers/policy.ts`. The shared home for
 * both is the gate middleware itself; moving it there means editing eight
 * issuance imports, so it is left as a follow-up rather than done from here.
 *
 * @param c - Request context carrying the gate's judgement.
 * @param custodyWalletId - The wallet the handler is about to sign with.
 */
export function assertJudgedDvpCustodyWallet(
  c: Context<{ Bindings: Env }>,
  custodyWalletId: string
): void {
  const judged = getPolicyGateContext<unknown, { judgedCustodyWalletId?: string }>(c).resolved
    ?.judgedCustodyWalletId;
  if (judged !== undefined && judged !== custodyWalletId) {
    throw conflict("Signing wallet changed after the operation was evaluated by policy");
  }
}

/**
 * The provider wallet id behind a custody wallet, which the candidate requires
 * and the DvP custody lookups do not return.
 *
 * @param env - API environment.
 * @param organizationId - Tenant that owns the wallet.
 * @param projectId - Project the wallet belongs to.
 * @param custodyWalletId - The resolved custody wallet.
 * @returns The provider's wallet id.
 */
async function providerWalletIdFor(
  env: Env,
  organizationId: string,
  projectId: string,
  custodyWalletId: string
): Promise<string> {
  const wallet = await new CustodyRuntimeTargets(
    getDb(env),
    env,
    new Map()
  ).findOperationalWalletById({ organizationId, projectId, custodyWalletId });
  if (wallet === null) {
    // The caller's own resolution just returned this id from the same tables, so
    // its absence here is not a caller error to report as one.
    throw internalError("DvP custody wallet disappeared while it was being judged");
  }
  return wallet.walletId;
}

function buildDvpPolicyCandidate(input: {
  auth: ApiKeyContext;
  trade: DvpTradeRow;
  custodyWalletId: string;
  walletId: string;
  operationType: DvpPolicyOperationType;
  asset: string | null;
  amount: string | null;
  destination: string | null;
  context: Record<string, unknown>;
}): PolicyCandidate {
  return {
    organizationId: input.auth.organizationId,
    projectId: input.trade.projectId,
    custodyWalletId: input.custodyWalletId,
    walletId: input.walletId,
    apiKeyId: input.auth.apiKeyId,
    actor: walletOperationActorFromAuth(input.auth),
    source: "api",
    operationFamily: "program",
    operationType: input.operationType,
    asset: input.asset,
    amount: input.amount,
    destination: input.destination,
    context: { tradeId: input.trade.id, ...input.context },
    providerExtensions: {},
  };
}

/**
 * The candidate for funding one leg.
 *
 * The amount judged is the leg's TARGET, not the live shortfall. That is what
 * makes an approval a ceiling rather than a trigger: `fundDvpTradeLeg` sends
 * `target - alreadyHeld`, which can never exceed the target, so the amount that
 * moves is always within the amount that was approved. Judging the live
 * shortfall instead would let a reclaim between approval and execution grow the
 * send past it.
 *
 * @param c - Validated request context naming the side.
 * @returns The extraction the gate enforces on.
 */
export async function extractDvpFundPolicyCandidate(
  c: ValidatedBodyContext<typeof fundDvpTradeSchema>
): Promise<PolicyGateExtraction> {
  const auth = getAuth(c);
  const { trade, params } = await resolveLegAction(c, c.req.valid("json"));
  const walletId = await providerWalletIdFor(
    c.env,
    auth.organizationId,
    params.projectId,
    params.custodyWalletId
  );
  const isA = params.side === "a";

  return {
    candidate: buildDvpPolicyCandidate({
      auth,
      trade,
      custodyWalletId: params.custodyWalletId,
      walletId,
      operationType: "dvp_fund",
      asset: isA ? trade.symbolA : trade.symbolB,
      amount: isA ? trade.amountA : trade.amountB,
      destination: isA ? trade.escrowA : trade.escrowB,
      context: {
        side: params.side,
        mint: isA ? trade.mintA : trade.mintB,
        counterparty: isA ? trade.userB : trade.userA,
      },
    }),
    legs: [],
    body: c.req.valid("json") as Record<string, unknown>,
    resolved: { judgedCustodyWalletId: params.custodyWalletId },
    rawPayload: {
      tradeId: trade.id,
      side: params.side,
      mint: isA ? trade.mintA : trade.mintB,
      escrow: isA ? trade.escrowA : trade.escrowB,
      targetAmount: isA ? trade.amountA : trade.amountB,
    },
    idempotencyKey: c.req.header(IDEMPOTENCY_KEY_HEADER) ?? null,
  };
}

/**
 * The candidate for settling a trade.
 *
 * A settle moves BOTH legs, so it carries no single amount or asset and an
 * amount rule cannot govern it. Both mints and both amounts travel in the
 * context instead, which is what an approver needs to see. Cancel is not gated
 * (see the header), so this covers settle alone.
 *
 * @param c - Request context naming the trade.
 * @returns The extraction the gate enforces on.
 */
export async function extractDvpSettlePolicyCandidate(
  c: Context<{ Bindings: Env }>
): Promise<PolicyGateExtraction> {
  const auth = getAuth(c);
  const { trade, settlement, projectId } = await resolveCloseAction(c, "settle");
  const walletId = await providerWalletIdFor(
    c.env,
    auth.organizationId,
    projectId,
    settlement.custodyWalletId
  );

  return {
    candidate: buildDvpPolicyCandidate({
      auth,
      trade,
      custodyWalletId: settlement.custodyWalletId,
      walletId,
      operationType: "dvp_settle",
      asset: null,
      amount: null,
      destination: null,
      context: {
        legA: { mint: trade.mintA, amount: trade.amountA, party: trade.userA },
        legB: { mint: trade.mintB, amount: trade.amountB, party: trade.userB },
        expiryTimestamp: trade.expiryTimestamp,
      },
    }),
    legs: [],
    body: {},
    resolved: { judgedCustodyWalletId: settlement.custodyWalletId },
    rawPayload: {
      tradeId: trade.id,
      action: "settle",
      legA: { mint: trade.mintA, amount: trade.amountA },
      legB: { mint: trade.mintB, amount: trade.amountB },
    },
    idempotencyKey: c.req.header(IDEMPOTENCY_KEY_HEADER) ?? null,
  };
}
