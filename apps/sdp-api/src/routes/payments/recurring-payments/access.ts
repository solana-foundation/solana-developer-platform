import { getDb } from "@/db";
import type { PaymentRecurringPaymentRow } from "@/db/repositories/payment-recurring-payments.repository";
import type { ApiKeyContext } from "@/lib/auth";
import { getAuth, requireProjectId } from "@/lib/auth";
import { AppError, notFound, walletNotFound } from "@/lib/errors";
import type { AuthorizeInput } from "@/middleware/authorize";
import { parseIdempotencyKey } from "@/middleware/idempotency-key";
import {
  assertApiKeyCustodyWalletAccess,
  getAllowedApiKeyWalletAuthorizationForPermissions,
  loadFreshApiKeyWalletScope,
} from "@/services/api-key-scope.service";
import type { CustodyWallet } from "@/services/stores/custody-config.store";
import {
  type AppContext,
  getCounterpartiesRepository,
  getCounterpartyAccountsRepository,
  getPaymentRecurringPaymentsRepository,
} from "../context";
import {
  findRetainedPaymentWallet,
  type ResolvedScope,
  resolveScope,
  resolveWalletByCustodyWalletId,
} from "../wallets";

/**
 * Access checks for the recurring-payment routes (HOO-1918, ADR 0008). They
 * run before the Idempotency-Key step, so a replay passes exactly these checks:
 * every id the request names, in the caller's project, and the credential's
 * wallet bindings read fresh (never the cached snapshot, which drops a binding
 * once its wallet is inactive). Access, never state: a wallet deactivated
 * since, or a schedule whose source wallet is unresolved, still passes here,
 * and the handler and services refuse new work on it.
 */

export interface AuthorizedRecurringPayment {
  scope: ResolvedScope;
  recurringPayment: PaymentRecurringPaymentRow;
  /** The schedule's pinned source wallet; null when the pin is unresolved (state). */
  sourceWallet: CustodyWallet | null;
}

export interface AuthorizedRecurringPaymentUpdate extends AuthorizedRecurringPayment {
  /** The wallet the update moves the schedule to, whatever its status, when it names another. */
  nextSourceWallet: CustodyWallet | undefined;
}

export interface AuthorizedRecurringPaymentCreate {
  scope: ResolvedScope;
  /** The named source wallet, whatever its status; the handler refuses an inactive one. */
  sourceWallet: CustodyWallet;
}

const PERMISSIONS = ["payments:write"] as const;

/** The caller with its wallet bindings read fresh, deactivated wallets kept. */
function freshWalletScope(c: AppContext): Promise<ApiKeyContext> {
  return loadFreshApiKeyWalletScope(getDb(c.env), getAuth(c), "any");
}

/** The counterparty and its account, in the caller's project whatever their status. */
async function assertCounterpartyAccountInProject(
  c: AppContext,
  input: { counterpartyId: string; counterpartyAccountId: string; checkCounterparty: boolean }
): Promise<void> {
  const tenant = { organizationId: getAuth(c).organizationId, projectId: requireProjectId(c) };
  if (input.checkCounterparty) {
    const counterparty = await getCounterpartiesRepository(c).getCounterpartyById({
      ...tenant,
      counterpartyId: input.counterpartyId,
      status: "any",
    });
    if (!counterparty) {
      throw notFound("Counterparty");
    }
  }
  const account = await getCounterpartyAccountsRepository(c).getCounterpartyAccountById({
    ...tenant,
    counterpartyId: input.counterpartyId,
    counterpartyAccountId: input.counterpartyAccountId,
    status: "any",
  });
  if (!account) {
    throw notFound("Counterparty account");
  }
}

/** Create: the source wallet and the counterparty account the body names, in the project. */
export async function authorizeRecurringPaymentCreate(
  c: AppContext,
  input: AuthorizeInput
): Promise<AuthorizedRecurringPaymentCreate> {
  // SAFETY: mounted after validateBody(createRecurringPaymentSchema).
  const body = input.body as {
    sourceCustodyWalletId: string;
    counterpartyId: string;
    counterpartyAccountId: string;
  };
  assertApiKeyCustodyWalletAccess(await freshWalletScope(c), body.sourceCustodyWalletId, [
    ...PERMISSIONS,
  ]);
  const scope = await resolveScope(
    c,
    parseIdempotencyKey(c) !== undefined ? body.sourceCustodyWalletId : undefined
  );
  const sourceWallet = resolveWalletByCustodyWalletId(scope.wallets, body.sourceCustodyWalletId);
  // Every id the caller names is checked before the key is claimed: a
  // counterparty account from another tenant never reaches the service.
  await assertCounterpartyAccountInProject(c, {
    counterpartyId: body.counterpartyId,
    counterpartyAccountId: body.counterpartyAccountId,
    checkCounterparty: false,
  });
  return { scope, sourceWallet };
}

async function authorizeExistingRecurringPayment(
  c: AppContext,
  input: AuthorizeInput,
  access: ApiKeyContext
): Promise<AuthorizedRecurringPayment> {
  // SAFETY: mounted after validateParams(recurringPaymentIdParamsSchema).
  const { id } = input.params as { id: string };
  const recurringPayment = await getPaymentRecurringPaymentsRepository(c).getRecurringPaymentById({
    recurringPaymentId: id,
    organizationId: access.organizationId,
    projectId: requireProjectId(c),
    walletAuthorization: getAllowedApiKeyWalletAuthorizationForPermissions(access, [
      ...PERMISSIONS,
    ]),
  });
  if (!recurringPayment) {
    throw new AppError("NOT_FOUND", "Recurring payment not found");
  }
  const custodyWalletId = recurringPayment.source_custody_wallet_id;
  const scope = await resolveScope(c, custodyWalletId);
  if (custodyWalletId === null) {
    // An unresolved pin is state; the handler refuses it (409).
    return { scope, recurringPayment, sourceWallet: null };
  }
  const sourceWallet = resolveWalletByCustodyWalletId(scope.wallets, custodyWalletId);
  assertApiKeyCustodyWalletAccess(access, sourceWallet.id, [...PERMISSIONS]);
  return { scope, recurringPayment, sourceWallet };
}

/** An action on an existing schedule: the schedule and its pinned source wallet. */
export async function authorizeRecurringPayment(
  c: AppContext,
  input: AuthorizeInput
): Promise<AuthorizedRecurringPayment> {
  return authorizeExistingRecurringPayment(c, input, await freshWalletScope(c));
}

/**
 * Update: the schedule, its source wallet, the wallet the body moves it to,
 * and the counterparty account it points it at, all in the project.
 */
export async function authorizeRecurringPaymentUpdate(
  c: AppContext,
  input: AuthorizeInput
): Promise<AuthorizedRecurringPaymentUpdate> {
  const access = await freshWalletScope(c);
  const authorized = await authorizeExistingRecurringPayment(c, input, access);
  // SAFETY: mounted after validateBody(updateRecurringPaymentSchema).
  const body = input.body as {
    sourceCustodyWalletId?: string;
    counterpartyId?: string;
    counterpartyAccountId?: string;
  };
  let nextSourceWallet: CustodyWallet | undefined;
  if (body.sourceCustodyWalletId && body.sourceCustodyWalletId !== authorized.sourceWallet?.id) {
    const named = await findRetainedPaymentWallet(c, body.sourceCustodyWalletId);
    if (!named) {
      throw walletNotFound();
    }
    assertApiKeyCustodyWalletAccess(access, named.id, [...PERMISSIONS]);
    nextSourceWallet = named;
  }
  if (body.counterpartyId !== undefined || body.counterpartyAccountId !== undefined) {
    await assertCounterpartyAccountInProject(c, {
      counterpartyId: body.counterpartyId ?? authorized.recurringPayment.counterparty_id,
      counterpartyAccountId:
        body.counterpartyAccountId ?? authorized.recurringPayment.counterparty_account_id,
      checkCounterparty: body.counterpartyId !== undefined,
    });
  }
  return { ...authorized, nextSourceWallet };
}
