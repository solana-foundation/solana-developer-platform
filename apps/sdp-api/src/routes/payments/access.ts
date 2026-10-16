import { getAuth, requireProjectId } from "@/lib/auth";
import { notFound, walletNotFound } from "@/lib/errors";
import type { AuthorizeInput } from "@/middleware/authorize";
import {
  type AppContext,
  getCounterpartiesRepository,
  getPaymentSubscriptionsRepository,
} from "./context";
import { authorizeProviderWallet, findRetainedPaymentWalletByWalletId } from "./wallets";

/**
 * Access checks for the payment routes that name wallets, plans and
 * counterparties (HOO-1918, ADR 0009). Each loads what the request names in the
 * caller's project, whatever its status, and checks the key's wallet access
 * fresh. State (an archived plan, an inactive wallet) stays in the handler.
 */

function body<T>(input: AuthorizeInput): T {
  // SAFETY: each check is mounted after validateBody with the route's schema.
  return input.body as T;
}

function planIdParam(input: AuthorizeInput): string {
  // SAFETY: mounted after validateParams(subscriptionPlanIdParamsSchema).
  return (input.params as { planId: string }).planId;
}

/** Payment-request create: the receiving wallet and any counterparty, in the caller's project. */
export async function authorizePaymentRequest(c: AppContext, input: AuthorizeInput) {
  const { walletId, counterpartyId } = body<{ walletId: string; counterpartyId: string | null }>(
    input
  );
  authorizeProviderWallet(c, walletId, ["payments:write"]);
  const [wallet, counterparty] = await Promise.all([
    findRetainedPaymentWalletByWalletId(c, walletId),
    counterpartyId
      ? getCounterpartiesRepository(c).getCounterpartyById({
          counterpartyId,
          organizationId: getAuth(c).organizationId,
          projectId: requireProjectId(c),
          status: "any",
        })
      : null,
  ]);
  if (!wallet) {
    throw walletNotFound();
  }
  if (counterpartyId && !counterparty) {
    throw notFound("Counterparty");
  }
}

/**
 * The owner wallet and any puller wallet: the key's binding to each, as
 * authentication read it (HOO-2048), and each in the caller's project whatever its status, so a
 * foreign wallet is a 404 before the key. Whether it is active is the handler's.
 */
async function authorizePlanWallets(
  c: AppContext,
  ownerWalletId: string,
  pullerWalletId: string | null | undefined
): Promise<void> {
  const walletIds =
    typeof pullerWalletId === "string" ? [ownerWalletId, pullerWalletId] : [ownerWalletId];
  for (const walletId of walletIds) {
    authorizeProviderWallet(c, walletId, ["payments:write"]);
  }
  const wallets = await Promise.all(
    walletIds.map((walletId) => findRetainedPaymentWalletByWalletId(c, walletId))
  );
  if (wallets.some((wallet) => wallet === null)) {
    throw walletNotFound();
  }
}

/** Plan create: the owner wallet and any puller wallet the body names. */
export async function authorizeSubscriptionPlanCreate(c: AppContext, input: AuthorizeInput) {
  const { ownerWalletId, pullerWalletId } = body<{
    ownerWalletId: string;
    pullerWalletId?: string;
  }>(input);
  await authorizePlanWallets(c, ownerWalletId, pullerWalletId);
}

/** Plan update: the plan in the caller's project, its owner wallet, and any new puller wallet. */
export async function authorizeSubscriptionPlanUpdate(c: AppContext, input: AuthorizeInput) {
  const plan = await getPaymentSubscriptionsRepository(c).getPlanById({
    planId: planIdParam(input),
    organizationId: getAuth(c).organizationId,
    projectId: requireProjectId(c),
  });
  if (!plan) {
    throw notFound("Subscription plan");
  }
  const { pullerWalletId } = body<{ pullerWalletId?: string | null }>(input);
  await authorizePlanWallets(c, plan.owner_wallet_id, pullerWalletId);
  return plan;
}

/** Subscription create: the plan and the counterparty it names, in the caller's project. */
export async function authorizeSubscriptionCreate(c: AppContext, input: AuthorizeInput) {
  const { planId, counterpartyId } = body<{ planId: string; counterpartyId: string }>(input);
  const auth = getAuth(c);
  const projectId = requireProjectId(c);
  const [plan, counterparty] = await Promise.all([
    getPaymentSubscriptionsRepository(c).getPlanById({
      planId,
      organizationId: auth.organizationId,
      projectId,
    }),
    getCounterpartiesRepository(c).getCounterpartyById({
      counterpartyId,
      organizationId: auth.organizationId,
      projectId,
      status: "any",
    }),
  ]);
  if (!plan) {
    throw notFound("Subscription plan");
  }
  if (!counterparty) {
    throw notFound("Counterparty");
  }
  return { plan, counterparty };
}
