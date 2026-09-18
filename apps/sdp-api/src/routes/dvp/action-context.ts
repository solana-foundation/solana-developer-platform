/**
 * Resolving what a DvP write acts on, in one place, because two callers need
 * the same answer (PRO-1975).
 *
 * A policy gate has to refuse before it records an operation, so the extractor
 * resolves the trade and the signing wallet exactly as the handler will, and
 * the handler then asserts the gate judged the wallet it ended up with. That is
 * the issuance pattern (`routes/issuance/handlers/policy.ts`): resolve twice,
 * compare, refuse a signer the gate never saw.
 *
 * These two resolvers moved out of `handlers.ts` unchanged. They live here
 * rather than there so `policy.ts` can call them without importing the module
 * that imports it back.
 */

import type { Context } from "hono";
import { getDb } from "@/db";
import { createDvpTradeRepository, type DvpTradeRow } from "@/db/repositories";
import { getAuth, requireProjectId } from "@/lib/auth";
import { forbidden, notFound } from "@/lib/errors";
import {
  assertFreshApiKeyActive,
  assertFreshApiKeyCustodyWalletAccess,
  getAllowedApiKeyCustodyWalletIdsForPermissions,
} from "@/services/api-key-scope.service";
import { custodyWalletForParty, walletIdIfHoldsAddress } from "@/services/dvp/custody-party";
import type { DvpCloseAction } from "@/services/dvp/settle";
import {
  type DvpSettlementWallet,
  readDvpSettlementWallet,
} from "@/services/dvp/settlement-wallet";
import type { Env } from "@/types/env";
import { type DvpTradeAuditActor, dvpTradeAuditActor } from "./trade-audit";

export interface DvpLegActionContext {
  trade: DvpTradeRow;
  actor: DvpTradeAuditActor;
  params: {
    side: "a" | "b";
    custodyWalletId: string;
    organizationId: string;
    projectId: string;
  };
}

export interface DvpCloseActionContext {
  trade: DvpTradeRow;
  actor: DvpTradeAuditActor;
  settlement: DvpSettlementWallet;
  projectId: string;
}

/**
 * Resolves the trade, the side and the custody wallet for an action on one leg.
 *
 * The right to act on side X, funding or reclaiming, is holding an active
 * custody wallet whose public key equals `user_x`. The auth context can be an
 * hour stale, so the wallet is derived and the key's binding asserted from the
 * database before anything is broadcast. Omitted `walletId`, that is the custody
 * lookup on the party address; explicit, it is that the named wallet still
 * holds the address (naming narrows).
 *
 * Takes the already-validated body rather than reading it, so the validated
 * read stays in the handler and the extractor that the route wires its
 * `validateBody` to (`validated-body-wiring.node.test.ts` enforces that
 * pairing, and this is a helper rather than a registered handler).
 *
 * @param c - Request context.
 * @param body - The validated body naming the side and any explicit wallet.
 * @returns The trade and the re-read wallet to sign with.
 */
export async function resolveLegAction(
  c: Context<{ Bindings: Env }>,
  body: { side: "a" | "b"; walletId?: string | null }
): Promise<DvpLegActionContext> {
  const auth = getAuth(c);
  const projectId = requireProjectId(c);
  const tradeId = c.req.param("tradeId");
  if (tradeId === undefined) {
    throw notFound("DvP trade not found");
  }
  const trade = await createDvpTradeRepository(c.env).getByIdAsParty(tradeId);
  if (trade === null) {
    throw notFound("DvP trade not found");
  }
  const side = body.side;
  const partyAddress = side === "a" ? trade.userA : trade.userB;

  const custodyWalletId =
    body.walletId !== null && body.walletId !== undefined
      ? await walletIdIfHoldsAddress(
          getDb(c.env),
          c.env,
          { organizationId: auth.organizationId, projectId },
          body.walletId,
          partyAddress
        )
      : await custodyWalletForParty(
          c.env,
          { organizationId: auth.organizationId, projectId },
          partyAddress,
          getAllowedApiKeyCustodyWalletIdsForPermissions(auth, ["payments:write"])
        );
  if (custodyWalletId === null) {
    throw forbidden(
      `DvP trade ${trade.id}: no active custody wallet in this project holds the side ${side} party address`
    );
  }
  await assertFreshApiKeyActive(getDb(c.env), auth);
  await assertFreshApiKeyCustodyWalletAccess(getDb(c.env), auth, custodyWalletId, [
    "payments:write",
  ]);

  return {
    trade,
    actor: dvpTradeAuditActor(auth),
    params: { side, custodyWalletId, organizationId: auth.organizationId, projectId },
  };
}

/**
 * Resolves the trade and the settlement wallet a close signs with.
 *
 * Re-reads the binding before anything irreversible: the auth context can be an
 * hour stale, and settling with a revoked key is an irreversible two-leg spend,
 * not a read slip. The wallet asserted is the SETTLEMENT wallet, the one that
 * signs; the liveness assert covers keys the wallet-scoped check skips.
 *
 * @param c - Request context naming the trade.
 * @param _action - Which close is being resolved; the resolution is the same
 *   for both and the parameter keeps call sites self-describing.
 * @returns The trade and the settlement wallet.
 */
export async function resolveCloseAction(
  c: Context<{ Bindings: Env }>,
  _action: DvpCloseAction
): Promise<DvpCloseActionContext> {
  const auth = getAuth(c);
  const projectId = requireProjectId(c);
  const tradeId = c.req.param("tradeId");
  if (tradeId === undefined) {
    throw notFound("DvP trade not found");
  }
  const trade = await createDvpTradeRepository(c.env).getById(
    {
      organizationId: auth.organizationId,
      projectId,
      sdpWalletIds: getAllowedApiKeyCustodyWalletIdsForPermissions(auth, ["payments:write"]),
    },
    tradeId
  );
  if (trade === null) {
    throw notFound("DvP trade not found");
  }
  const settlement = await readDvpSettlementWallet(c.env, {
    organizationId: trade.organizationId,
    projectId: trade.projectId,
  });
  if (settlement === null) {
    throw notFound("DvP settlement wallet not found for this trade's project");
  }

  await assertFreshApiKeyActive(getDb(c.env), auth);
  await assertFreshApiKeyCustodyWalletAccess(getDb(c.env), auth, settlement.custodyWalletId, [
    "payments:write",
  ]);

  return { trade, actor: dvpTradeAuditActor(auth), settlement, projectId };
}
