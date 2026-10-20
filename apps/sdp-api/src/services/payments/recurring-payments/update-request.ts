import { decideRecurringPaymentUpdateTransition } from "@sdp/payments/recurring-payment-lifecycle";
import {
  assertNever,
  doesRecurringPaymentStatusRequireReactivation,
  isActivatingRecurringPaymentStatus,
  isCanceledRecurringPaymentStatus,
  type PaymentRecurringPaymentUpdateAttemptMode,
  recurringPaymentInFlightLifecycleOperation,
  type UpdatePaymentRecurringPaymentRequest,
} from "@sdp/types/payments";
import { z } from "zod";
import type {
  PaymentRecurringPaymentRow,
  PaymentRecurringPaymentUpdateAttemptRow,
} from "@/db/repositories/payment-recurring-payments.repository";
import { badRequest, conflict, internalError } from "@/lib/errors";
import { normalizeDecimalString } from "@/lib/idempotency";
import { resolveSolanaCounterpartyAccount } from "@/services/payments/counterparty-account-resolution";
import type { Env } from "@/types/env";
import { assertRecurringPaymentTokenMint, type RecurringPaymentSourceWallet } from "./shared";

/** An update request's Idempotency-Key and the fingerprint of its validated body. */
export interface RecurringPaymentUpdateIdempotency {
  key: string;
  fingerprint: string;
}

export const recurringPaymentUpdateSnapshotSchema = z.object({
  sourceCustodyWalletId: z.string().nullable(),
  counterpartyId: z.string(),
  counterpartyAccountId: z.string(),
  token: z.string(),
  amount: z.string(),
  periodHours: z.number(),
  firstCollectionAt: z.string().nullable(),
  nextCollectionDueAt: z.string().nullable(),
  metadataUri: z.string().nullable(),
});

type RecurringPaymentUpdateSnapshot = z.infer<typeof recurringPaymentUpdateSnapshotSchema>;

/**
 * The values an update attempt saved (`before_values`, `after_values`): any
 * subset of the snapshot's fields, and nothing else.
 */
const savedUpdateValuesSchema = recurringPaymentUpdateSnapshotSchema.partial().strict();
type SavedUpdateValues = z.infer<typeof savedUpdateValuesSchema>;

export const RECURRING_PAYMENT_UPDATE_FIELDS = [
  "sourceCustodyWalletId",
  "counterpartyId",
  "counterpartyAccountId",
  "token",
  "amount",
  "periodHours",
  "firstCollectionAt",
  "nextCollectionDueAt",
  "metadataUri",
] as const satisfies readonly (keyof RecurringPaymentUpdateSnapshot)[];
type RecurringPaymentUpdateField = (typeof RECURRING_PAYMENT_UPDATE_FIELDS)[number];

export type ResolvedRecurringPaymentUpdate = {
  sourceWallet: RecurringPaymentSourceWallet;
  counterpartyId: string;
  counterpartyAccountId: string;
  destinationAddress: string;
  token: string;
  amount: string;
  periodHours: number;
  firstCollectionAt: string | null;
  nextCollectionDueAt: string | null;
  metadataUri: string | null;
  changedFields: Array<keyof RecurringPaymentUpdateSnapshot>;
  beforeValues: SavedUpdateValues;
  afterValues: SavedUpdateValues;
};

/**
 * An update's terms as a claimed run uses them. A replacement's destination is not among them: a
 * request carries the one it resolved in `ClaimedUpdateStarts`, and the cron finalizes on the
 * destination its landed plan holds on chain (`replacementFinalDestination`).
 */
export type RecurringPaymentUpdateTerms = Omit<
  ResolvedRecurringPaymentUpdate,
  "destinationAddress"
>;

/**
 * Whether a claimed update may send new steps. A request may, and creates a replacement plan for
 * the destination it resolved; the cron sends no new update step (its mandate admits no
 * `recurring.update`), so it never creates a plan and needs no destination.
 */
export type ClaimedUpdateStarts =
  | { allowed: true; destinationAddress: string }
  | { allowed: false };

export const REPLACEMENT_UPDATE_FIELDS = new Set<keyof RecurringPaymentUpdateSnapshot>([
  "sourceCustodyWalletId",
  "counterpartyId",
  "counterpartyAccountId",
  "token",
  "amount",
  "periodHours",
]);

function recurringPaymentSnapshot(row: PaymentRecurringPaymentRow): RecurringPaymentUpdateSnapshot {
  return {
    sourceCustodyWalletId: row.source_custody_wallet_id,
    counterpartyId: row.counterparty_id,
    counterpartyAccountId: row.counterparty_account_id,
    token: row.token,
    amount: row.amount,
    periodHours: row.period_hours,
    firstCollectionAt: row.first_collection_at,
    nextCollectionDueAt: row.next_collection_due_at,
    metadataUri: row.metadata_uri,
  };
}

function buildUpdateDiff(
  before: RecurringPaymentUpdateSnapshot,
  after: RecurringPaymentUpdateSnapshot
): {
  changedFields: RecurringPaymentUpdateField[];
  beforeValues: Partial<RecurringPaymentUpdateSnapshot>;
  afterValues: Partial<RecurringPaymentUpdateSnapshot>;
} {
  // An amount is compared by value, so a respelling ("1" and "1.0") is no change
  // and never broadcasts a replacement.
  const changedFields = RECURRING_PAYMENT_UPDATE_FIELDS.filter((field) =>
    field === "amount"
      ? normalizeDecimalString(before.amount) !== normalizeDecimalString(after.amount)
      : before[field] !== after[field]
  );
  const beforeValues: Partial<RecurringPaymentUpdateSnapshot> = { ...before };
  const afterValues: Partial<RecurringPaymentUpdateSnapshot> = { ...after };

  return { changedFields, beforeValues, afterValues };
}

function sameStringSet(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value) => right.includes(value));
}

/** One snapshot field: an amount by value ("30" and "30.0" are one amount), the rest as stored. */
function sameSnapshotValue(
  field: RecurringPaymentUpdateField,
  left: SavedUpdateValues,
  right: SavedUpdateValues
): boolean {
  if (field === "amount" && left.amount !== undefined && right.amount !== undefined) {
    return normalizeDecimalString(left.amount) === normalizeDecimalString(right.amount);
  }
  return left[field] === right[field];
}

/** The same fields, each the same value (`sameSnapshotValue`). */
function sameSavedValues(left: SavedUpdateValues, right: SavedUpdateValues): boolean {
  return RECURRING_PAYMENT_UPDATE_FIELDS.every(
    (field) => field in left === field in right && sameSnapshotValue(field, left, right)
  );
}

export function updateAttemptMatchesRequest(
  attempt: PaymentRecurringPaymentUpdateAttemptRow,
  input: {
    changedFields: string[];
    beforeValues: SavedUpdateValues;
    afterValues: SavedUpdateValues;
  }
): boolean {
  // Parsed where they are read: a row whose saved values are not a snapshot
  // subset is not this request's attempt.
  const before = savedUpdateValuesSchema.safeParse(attempt.before_values);
  const after = savedUpdateValuesSchema.safeParse(attempt.after_values);
  return (
    before.success &&
    after.success &&
    sameStringSet(attempt.changed_fields, input.changedFields) &&
    sameSavedValues(before.data, input.beforeValues) &&
    sameSavedValues(after.data, input.afterValues)
  );
}

export function requestedActiveUpdateMode(
  changedFields: Array<keyof RecurringPaymentUpdateSnapshot>
): PaymentRecurringPaymentUpdateAttemptMode {
  return changedFields.some((field) => REPLACEMENT_UPDATE_FIELDS.has(field))
    ? "replacement"
    : "metadata_schedule";
}

export function assertRecurringPaymentUpdateStatus(
  row: PaymentRecurringPaymentRow,
  nowIso: string
): void {
  const transition = decideRecurringPaymentUpdateTransition({
    status: row.status,
    updatedAt: row.updated_at,
    nowIso,
  });
  switch (transition) {
    case "claimable":
    case "recoverable":
      return;
    case "processing":
      throw conflict("Recurring payment update is already processing");
    case "already_final":
    case "invalid": {
      if (isActivatingRecurringPaymentStatus(row.status)) {
        throw conflict("Recurring payment activation is already processing");
      }
      const lifecycleOperation = recurringPaymentInFlightLifecycleOperation(row.status);
      if (lifecycleOperation) {
        throw conflict(`Recurring payment ${lifecycleOperation} is already processing`);
      }
      if (
        doesRecurringPaymentStatusRequireReactivation(row.status) ||
        isCanceledRecurringPaymentStatus(row.status)
      ) {
        throw conflict("Recurring payment cannot be updated from this status");
      }
      throw internalError(`Inconsistent update transition ${transition} for ${row.status}`);
    }
    default:
      assertNever(transition);
  }
}

export async function resolveRecurringPaymentUpdate(input: {
  env: Env;
  organizationId: string;
  projectId: string;
  recurringPayment: PaymentRecurringPaymentRow;
  sourceWallet: RecurringPaymentSourceWallet;
  nextSourceWallet?: RecurringPaymentSourceWallet;
  request: UpdatePaymentRecurringPaymentRequest;
}): Promise<ResolvedRecurringPaymentUpdate> {
  const finalSourceWallet =
    input.nextSourceWallet === undefined ? input.sourceWallet : input.nextSourceWallet;
  const requestedSourceCustodyWalletId =
    input.request.sourceCustodyWalletId === undefined
      ? input.recurringPayment.source_custody_wallet_id
      : input.request.sourceCustodyWalletId;
  if (finalSourceWallet.id !== requestedSourceCustodyWalletId) {
    throw badRequest("Recurring payment source wallet does not match request");
  }

  const counterpartyId =
    input.request.counterpartyId === undefined
      ? input.recurringPayment.counterparty_id
      : input.request.counterpartyId;
  const counterpartyAccountId =
    input.request.counterpartyAccountId === undefined
      ? input.recurringPayment.counterparty_account_id
      : input.request.counterpartyAccountId;
  const accountChanged =
    counterpartyId !== input.recurringPayment.counterparty_id ||
    counterpartyAccountId !== input.recurringPayment.counterparty_account_id;
  const [token, destination] = await Promise.all([
    input.request.token !== undefined
      ? assertRecurringPaymentTokenMint(
          input.request.token,
          input.organizationId,
          input.projectId,
          input.env
        )
      : input.recurringPayment.token,
    accountChanged
      ? resolveSolanaCounterpartyAccount({
          env: input.env,
          organizationId: input.organizationId,
          projectId: input.projectId,
          counterpartyId,
          counterpartyAccountId,
        })
      : { destinationAddress: input.recurringPayment.destination_address },
  ]);
  const amount =
    input.request.amount === undefined ? input.recurringPayment.amount : input.request.amount;
  const periodHours =
    input.request.periodHours === undefined
      ? input.recurringPayment.period_hours
      : input.request.periodHours;
  const firstCollectionAt =
    input.request.firstCollectionAt !== undefined
      ? input.request.firstCollectionAt
      : input.recurringPayment.first_collection_at;
  const nextCollectionDueAt =
    input.request.nextCollectionDueAt !== undefined
      ? input.request.nextCollectionDueAt
      : input.recurringPayment.next_collection_due_at;
  const metadataUri =
    input.request.metadataUri !== undefined
      ? input.request.metadataUri
      : input.recurringPayment.metadata_uri;

  const before = recurringPaymentSnapshot(input.recurringPayment);
  const after: RecurringPaymentUpdateSnapshot = {
    sourceCustodyWalletId: finalSourceWallet.id,
    counterpartyId,
    counterpartyAccountId,
    token,
    amount,
    periodHours,
    firstCollectionAt,
    nextCollectionDueAt,
    metadataUri,
  };
  const diff = buildUpdateDiff(before, after);

  return {
    sourceWallet: finalSourceWallet,
    counterpartyId,
    counterpartyAccountId,
    destinationAddress: destination.destinationAddress,
    token,
    amount,
    periodHours,
    firstCollectionAt,
    nextCollectionDueAt,
    metadataUri,
    ...diff,
  };
}
