import type { MovementId } from "@sdp/types/movements";
import type { PaymentRecurringPaymentRow } from "@/db/repositories/payment-recurring-payments.repository";
import { type ApiKeyContext, getAuth, requireProjectId } from "@/lib/auth";
import { AppError, notFound, walletNotFound } from "@/lib/errors";
import { assertWalletPurposeAdmitted } from "@/lib/money-admission";
import type { AuthorizeInput } from "@/middleware/authorize";
import {
  type AppContext,
  getCounterpartiesRepository,
  getCounterpartyAccountsRepository,
  getPaymentRecurringPaymentsRepository,
} from "@/routes/payments/context";
import {
  findRetainedPaymentWallet,
  type ResolvedScope,
  resolveScope,
  resolveWalletByCustodyWalletId,
} from "@/routes/payments/wallets";
import type { CustodyWallet } from "@/services/stores/custody-config.store";

/**
 * Access checks for the recurring-payment routes (HOO-1918, ADR 0009). They
 * run before the Idempotency-Key step, so a replay passes exactly these checks:
 * every id the request names, in the caller's project. Project-scoped: whether
 * a key may sign with the source wallet is the custody signer's decision, and
 * a start it may not make is refused before its attempt is claimed (HOO-2099).
 * Access, never state: a wallet deactivated
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

/** The counterparty's account, in the caller's project whatever its status. */
async function assertCounterpartyAccountInProject(
  c: AppContext,
  input: { counterpartyId: string; counterpartyAccountId: string }
): Promise<void> {
  const tenant = { organizationId: getAuth(c).organizationId, projectId: requireProjectId(c) };
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

/**
 * Update: each counterparty id the body names is in the project, whatever its
 * status. Only the request's own ids are paired, never the schedule's current
 * ones, which a later edit may have changed: a retry of an edit that already
 * ran must still reach its replay. Whether the account fits the schedule now
 * is the handler's check, for new work.
 */
async function assertNamedCounterpartyIdsInProject(
  c: AppContext,
  body: { counterpartyId?: string; counterpartyAccountId?: string }
): Promise<void> {
  const tenant = { organizationId: getAuth(c).organizationId, projectId: requireProjectId(c) };
  if (body.counterpartyId !== undefined && body.counterpartyAccountId !== undefined) {
    await assertCounterpartyAccountInProject(c, {
      counterpartyId: body.counterpartyId,
      counterpartyAccountId: body.counterpartyAccountId,
    });
    return;
  }
  if (body.counterpartyId !== undefined) {
    const counterparty = await getCounterpartiesRepository(c).getCounterpartyById({
      ...tenant,
      counterpartyId: body.counterpartyId,
      status: "any",
    });
    if (!counterparty) {
      throw notFound("Counterparty");
    }
  }
  if (body.counterpartyAccountId !== undefined) {
    const [account] = await getCounterpartyAccountsRepository(
      c
    ).listCounterpartyAccountsByIdsInProject({
      ...tenant,
      counterpartyAccountIds: [body.counterpartyAccountId],
      status: "any",
    });
    if (account === undefined) {
      throw notFound("Counterparty account");
    }
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
  const scope = await resolveScope(c, body.sourceCustodyWalletId);
  const sourceWallet = resolveWalletByCustodyWalletId(scope.wallets, body.sourceCustodyWalletId);
  assertWalletPurposeAdmitted(scope.auth, sourceWallet, "recurring.activate");
  // Every id the caller names is checked before the key is claimed: a
  // counterparty account from another tenant never reaches the service.
  await assertCounterpartyAccountInProject(c, {
    counterpartyId: body.counterpartyId,
    counterpartyAccountId: body.counterpartyAccountId,
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
  return { scope, recurringPayment, sourceWallet };
}

/** An action on an existing schedule: the schedule and its pinned source wallet. */
export async function authorizeRecurringPayment(
  c: AppContext,
  input: AuthorizeInput
): Promise<AuthorizedRecurringPayment> {
  return authorizeExistingRecurringPayment(c, input, getAuth(c));
}

/**
 * A start on an existing schedule (activate, collect, resume): as
 * {@link authorizeRecurringPayment}, and the pinned source wallet's purpose
 * may sign the movement. Cancel is an exit and never asks, so a schedule can
 * always be unwound.
 *
 * @param c - Request context.
 * @param input - The validated request.
 * @param movement - The start the route signs.
 * @returns The schedule and its pinned source wallet.
 */
export async function authorizeRecurringPaymentStart(
  c: AppContext,
  input: AuthorizeInput,
  movement: MovementId
): Promise<AuthorizedRecurringPayment> {
  const authorized = await authorizeRecurringPayment(c, input);
  if (authorized.sourceWallet !== null) {
    assertWalletPurposeAdmitted(authorized.scope.auth, authorized.sourceWallet, movement);
  }
  return authorized;
}

/**
 * Update: the schedule, its source wallet, the wallet the body moves it to,
 * and the counterparty account it points it at, all in the project.
 */
export async function authorizeRecurringPaymentUpdate(
  c: AppContext,
  input: AuthorizeInput
): Promise<AuthorizedRecurringPaymentUpdate> {
  const access = getAuth(c);
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
    assertWalletPurposeAdmitted(access, named, "recurring.update");
    nextSourceWallet = named;
  } else if (authorized.sourceWallet !== null) {
    assertWalletPurposeAdmitted(access, authorized.sourceWallet, "recurring.update");
  }
  await assertNamedCounterpartyIdsInProject(c, body);
  return { ...authorized, nextSourceWallet };
}
