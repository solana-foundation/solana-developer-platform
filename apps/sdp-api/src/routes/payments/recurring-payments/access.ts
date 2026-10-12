import { getDb } from "@/db";
import type { PaymentRecurringPaymentRow } from "@/db/repositories/payment-recurring-payments.repository";
import { getAuth, requireProjectId } from "@/lib/auth";
import { AppError, notFound } from "@/lib/errors";
import type { AuthorizeInput } from "@/middleware/authorize";
import { parseIdempotencyKey } from "@/middleware/idempotency-key";
import {
  assertFreshApiKeyCustodyWalletAccess,
  getAllowedApiKeyWalletAuthorizationForPermissions,
} from "@/services/api-key-scope.service";
import type { CustodyWallet } from "@/services/stores/custody-config.store";
import {
  type AppContext,
  getCounterpartyAccountsRepository,
  getPaymentRecurringPaymentsRepository,
} from "../context";
import {
  assertPaymentWalletExactAccess,
  type ResolvedScope,
  resolveScope,
  resolveWalletByCustodyWalletId,
} from "../wallets";

/**
 * Access checks for the recurring-payment routes (HOO-1918, ADR 0008). They
 * run before the Idempotency-Key step, so a replay passes exactly these checks:
 * the schedule in the caller's project and within its key's wallet access, and
 * the source wallet's binding read fresh. A wallet deactivated since still
 * passes (a replay moves nothing); the services' admission refuses new work.
 */

type PinnedRecurringPayment = PaymentRecurringPaymentRow & { source_custody_wallet_id: string };

export interface AuthorizedRecurringPayment {
  scope: ResolvedScope;
  recurringPayment: PinnedRecurringPayment;
  sourceWallet: CustodyWallet;
}

export interface AuthorizedRecurringPaymentUpdate extends AuthorizedRecurringPayment {
  /** The wallet the update moves the schedule to, when it names a different one. */
  nextSourceWallet: CustodyWallet | undefined;
}

export interface AuthorizedRecurringPaymentCreate {
  scope: ResolvedScope;
  sourceWallet: CustodyWallet;
}

const PERMISSIONS = ["payments:write"] as const;

async function assertSourceWalletAccess(
  c: AppContext,
  scope: ResolvedScope,
  wallet: CustodyWallet
): Promise<void> {
  assertPaymentWalletExactAccess(c, wallet.id, [...PERMISSIONS]);
  await assertFreshApiKeyCustodyWalletAccess(
    getDb(c.env),
    scope.auth,
    wallet.id,
    [...PERMISSIONS],
    "any"
  );
}

function pinned(recurringPayment: PaymentRecurringPaymentRow): PinnedRecurringPayment {
  if (recurringPayment.source_custody_wallet_id === null) {
    throw new AppError("CONFLICT", "Recurring payment source wallet is unresolved");
  }
  // SAFETY: narrowed by the null check above.
  return recurringPayment as PinnedRecurringPayment;
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
  assertPaymentWalletExactAccess(c, body.sourceCustodyWalletId, [...PERMISSIONS]);
  const scope = await resolveScope(
    c,
    parseIdempotencyKey(c) !== undefined ? body.sourceCustodyWalletId : undefined
  );
  const sourceWallet = resolveWalletByCustodyWalletId(scope.wallets, body.sourceCustodyWalletId);
  await assertSourceWalletAccess(c, scope, sourceWallet);
  // Every id the caller names is checked before the key is claimed: a
  // counterparty account from another tenant never reaches the service.
  const account = await getCounterpartyAccountsRepository(c).getCounterpartyAccountById({
    counterpartyId: body.counterpartyId,
    counterpartyAccountId: body.counterpartyAccountId,
    organizationId: scope.auth.organizationId,
    projectId: requireProjectId(c),
    status: "any",
  });
  if (!account) {
    throw notFound("Counterparty account");
  }
  return { scope, sourceWallet };
}

/** An action on an existing schedule: the schedule and its pinned source wallet. */
export async function authorizeRecurringPayment(
  c: AppContext,
  input: AuthorizeInput
): Promise<AuthorizedRecurringPayment> {
  const auth = getAuth(c);
  // SAFETY: mounted after validateParams(recurringPaymentIdParamsSchema).
  const { id } = input.params as { id: string };
  const row = await getPaymentRecurringPaymentsRepository(c).getRecurringPaymentById({
    recurringPaymentId: id,
    organizationId: auth.organizationId,
    projectId: requireProjectId(c),
    walletAuthorization: getAllowedApiKeyWalletAuthorizationForPermissions(auth, [...PERMISSIONS]),
  });
  if (!row) {
    throw new AppError("NOT_FOUND", "Recurring payment not found");
  }
  const recurringPayment = pinned(row);
  const scope = await resolveScope(c, recurringPayment.source_custody_wallet_id);
  const sourceWallet = resolveWalletByCustodyWalletId(
    scope.wallets,
    recurringPayment.source_custody_wallet_id
  );
  await assertSourceWalletAccess(c, scope, sourceWallet);
  return { scope, recurringPayment, sourceWallet };
}

/** Update: the schedule, its source wallet, and the wallet the body moves it to. */
export async function authorizeRecurringPaymentUpdate(
  c: AppContext,
  input: AuthorizeInput
): Promise<AuthorizedRecurringPaymentUpdate> {
  const authorized = await authorizeRecurringPayment(c, input);
  // SAFETY: mounted after validateBody(updateRecurringPaymentSchema).
  const { sourceCustodyWalletId } = input.body as { sourceCustodyWalletId?: string };
  const nextSourceWallet =
    sourceCustodyWalletId && sourceCustodyWalletId !== authorized.sourceWallet.id
      ? resolveWalletByCustodyWalletId(authorized.scope.wallets, sourceCustodyWalletId)
      : undefined;
  if (nextSourceWallet) {
    await assertSourceWalletAccess(c, authorized.scope, nextSourceWallet);
  }
  return { ...authorized, nextSourceWallet };
}
