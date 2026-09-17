import {
  type CreatePaymentRecurringPaymentRequest,
  type ListPaymentRecurringPaymentsResponse,
  PAYMENT_RECURRING_PAYMENT_STATUSES,
  PAYMENT_SUBSCRIPTION_COLLECTION_ATTEMPT_STATUSES,
  type PaymentRecurringPayment,
  type PaymentRecurringPaymentAction,
  type PaymentRecurringPaymentCollectionResponse,
  type PaymentRecurringPaymentResponse,
  type PaymentRecurringPaymentStatus,
  type PaymentSubscriptionCollectionAttempt,
  paymentSubscriptionCollectionAttemptMetadataSchema,
  type UpdatePaymentRecurringPaymentRequest,
} from "@sdp/types";
import { z } from "zod";
import type { MessageKey, TranslationValues } from "@/i18n/messages";
import type { SdpApiClient } from "@/lib/sdp-api";
import { getPaymentApiError, parsePaymentApiErrorText } from "../payment-api-errors";

type Translate = (key: MessageKey, values?: TranslationValues) => string;

export const RECURRING_PAYMENTS_PAGE_SIZE = 100;

export const RECURRING_LIST_DEFAULT_PAGE_SIZE = 25;

export { PAYMENT_RECURRING_PAYMENT_STATUSES as RECURRING_PAYMENT_STATUSES };
export type RecurringPaymentAction = PaymentRecurringPaymentAction;

export interface RecurringPaymentsListOptions {
  page?: number;
  pageSize?: number;
  status?: PaymentRecurringPaymentStatus | null;
  counterpartyId?: string;
}

export interface RecurringPaymentsListState {
  page: number;
  pageSize: number;
  status: PaymentRecurringPaymentStatus | null;
}

function firstParamValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function parseListInteger(value: string | undefined, fallback: number): number {
  if (value === undefined || !/^\d+$/.test(value)) {
    return fallback;
  }
  const parsed = Number(value);
  return parsed > 0 ? parsed : fallback;
}

export function parseRecurringPaymentsListParams(
  params: Record<string, string | string[] | undefined>
): RecurringPaymentsListState {
  const status = z
    .enum(PAYMENT_RECURRING_PAYMENT_STATUSES)
    .safeParse(firstParamValue(params.status));
  return {
    page: parseListInteger(firstParamValue(params.page), 1),
    pageSize: Math.min(
      parseListInteger(firstParamValue(params.pageSize), RECURRING_LIST_DEFAULT_PAGE_SIZE),
      RECURRING_PAYMENTS_PAGE_SIZE
    ),
    status: status.success ? status.data : null,
  };
}

interface ClientRecurringPaymentsListOptions extends RecurringPaymentsListOptions {
  signal?: AbortSignal;
}

export type RecurringFetchResult<T> =
  | { ok: true; data: T }
  | { ok: false; status: number | null; error: string };

const recurringPaymentSchema = z.object({
  id: z.string(),
  organizationId: z.string(),
  projectId: z.string(),
  sourceCustodyWalletId: z.string().nullable(),
  sourceProviderWalletId: z.string(),
  sourceAddress: z.string(),
  counterpartyId: z.string(),
  counterpartyAccountId: z.string(),
  destinationAddress: z.string(),
  destinationTokenAccount: z.string().nullable(),
  token: z.string(),
  amount: z.string(),
  periodHours: z.number(),
  firstCollectionAt: z.string().nullable(),
  nextCollectionDueAt: z.string().nullable(),
  planId: z.string().nullable(),
  subscriptionId: z.string().nullable(),
  planPda: z.string().nullable(),
  planCreatedAt: z.string().nullable(),
  planCreationSignature: z.string().nullable(),
  subscriptionPda: z.string().nullable(),
  subscriptionAuthorityAddress: z.string().nullable(),
  authorizationSignature: z.string().nullable(),
  status: z.enum(PAYMENT_RECURRING_PAYMENT_STATUSES),
  metadataUri: z.string().nullable(),
  createdBy: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
const collectionAttemptSchema = z.object({
  id: z.string(),
  organizationId: z.string(),
  projectId: z.string(),
  subscriptionId: z.string(),
  transferId: z.string().nullable(),
  token: z.string(),
  amount: z.string(),
  dueAt: z.string(),
  attemptedAt: z.string().nullable(),
  status: z.enum(PAYMENT_SUBSCRIPTION_COLLECTION_ATTEMPT_STATUSES),
  signature: z.string().nullable(),
  error: z.string().nullable(),
  metadata: paymentSubscriptionCollectionAttemptMetadataSchema,
  createdAt: z.string(),
  updatedAt: z.string(),
});
const recurringPaymentResponseSchema = z.object({ recurringPayment: recurringPaymentSchema });
const recurringPaymentsListResponseSchema = z.object({
  recurringPayments: z.array(recurringPaymentSchema),
  total: z.number(),
  page: z.number(),
  pageSize: z.number(),
});
const collectionAttemptsResponseSchema = z.object({
  collectionAttempts: z.array(collectionAttemptSchema),
  total: z.number(),
  page: z.number(),
  pageSize: z.number(),
});
const recurringPaymentsListEnvelopeSchema = z.object({ data: recurringPaymentsListResponseSchema });
const recurringPaymentEnvelopeSchema = z.object({ data: recurringPaymentResponseSchema });
const collectionAttemptsEnvelopeSchema = z.object({ data: collectionAttemptsResponseSchema });
const apiErrorEnvelopeSchema = z.object({
  error: z.union([z.string(), z.object({ message: z.string() })]),
  message: z.string().optional(),
});

function dashboardEnvelopeSchema<T extends z.ZodType>(dataSchema: T) {
  return z.union([z.object({ data: dataSchema }), apiErrorEnvelopeSchema]);
}

const dashboardRecurringPaymentEnvelopeSchema = dashboardEnvelopeSchema(
  recurringPaymentResponseSchema
);
const dashboardRecurringPaymentsListEnvelopeSchema = dashboardEnvelopeSchema(
  recurringPaymentsListResponseSchema
);

export interface RecurringPaymentCollectionAttemptsResult {
  collectionAttempts: PaymentSubscriptionCollectionAttempt[];
  total: number;
}

function setPositiveInteger(query: URLSearchParams, key: string, value: number | undefined) {
  if (value !== undefined && Number.isInteger(value) && value > 0) {
    query.set(key, String(value));
  }
}

export function buildRecurringPaymentsQuery(
  options: RecurringPaymentsListOptions
): URLSearchParams {
  const query = new URLSearchParams();
  setPositiveInteger(query, "page", options.page);
  setPositiveInteger(query, "pageSize", options.pageSize);
  if (options.status !== undefined && options.status !== null) {
    query.set("status", options.status);
  }
  if (options.counterpartyId !== undefined) {
    query.set("counterpartyId", options.counterpartyId);
  }
  return query;
}

async function readDashboardEnvelope<T>(
  response: Response,
  schema: z.ZodType<{ data: T } | z.infer<typeof apiErrorEnvelopeSchema>>,
  fallback: string,
  t: Translate
): Promise<T> {
  const body = schema.parse(await response.json());
  if (!response.ok) {
    throw new Error(getPaymentApiError(body, `${fallback} (${response.status}).`));
  }
  if (!("data" in body)) {
    throw new Error(t("DashboardPayments.recurring.emptyResponse", { request: fallback }));
  }
  return body.data;
}

export async function listRecurringPayments(
  options: ClientRecurringPaymentsListOptions,
  t: Translate
): Promise<ListPaymentRecurringPaymentsResponse> {
  const { signal, ...filters } = options;
  const query = buildRecurringPaymentsQuery({
    page: filters.page ?? 1,
    pageSize: filters.pageSize ?? RECURRING_PAYMENTS_PAGE_SIZE,
    status: filters.status,
    counterpartyId: filters.counterpartyId,
  });
  const response = await fetch(`/api/dashboard/payments/recurring-payments?${query.toString()}`, {
    method: "GET",
    cache: "no-store",
    signal,
  });
  return readDashboardEnvelope<ListPaymentRecurringPaymentsResponse>(
    response,
    dashboardRecurringPaymentsListEnvelopeSchema,
    t("DashboardPayments.recurring.unableToLoad"),
    t
  );
}

export async function getRecurringPayment(
  recurringPaymentId: string,
  signal: AbortSignal | undefined,
  t: Translate
): Promise<PaymentRecurringPayment> {
  const response = await fetch(
    `/api/dashboard/payments/recurring-payments/${encodeURIComponent(recurringPaymentId)}`,
    {
      method: "GET",
      cache: "no-store",
      signal,
    }
  );
  const data = await readDashboardEnvelope<PaymentRecurringPaymentResponse>(
    response,
    dashboardRecurringPaymentEnvelopeSchema,
    t("DashboardPayments.recurring.unableToLoad"),
    t
  );
  return data.recurringPayment;
}

export async function createRecurringPayment(
  input: CreatePaymentRecurringPaymentRequest,
  signal: AbortSignal | undefined,
  t: Translate
): Promise<PaymentRecurringPayment> {
  const response = await fetch("/api/dashboard/payments/recurring-payments", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
    signal,
  });
  const data = await readDashboardEnvelope<PaymentRecurringPaymentResponse>(
    response,
    dashboardRecurringPaymentEnvelopeSchema,
    t("DashboardPayments.recurring.unableToCreate"),
    t
  );
  return data.recurringPayment;
}

export async function updateRecurringPayment(
  recurringPaymentId: string,
  input: UpdatePaymentRecurringPaymentRequest,
  signal: AbortSignal | undefined,
  t: Translate
): Promise<PaymentRecurringPayment> {
  const response = await fetch(
    `/api/dashboard/payments/recurring-payments/${encodeURIComponent(recurringPaymentId)}`,
    {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
      signal,
    }
  );
  const data = await readDashboardEnvelope<PaymentRecurringPaymentResponse>(
    response,
    dashboardRecurringPaymentEnvelopeSchema,
    t("DashboardPayments.recurring.paymentUpdateFailed"),
    t
  );
  return data.recurringPayment;
}

export async function runRecurringPaymentAction(
  recurringPaymentId: string,
  action: RecurringPaymentAction,
  signal: AbortSignal | undefined,
  t: Translate
): Promise<PaymentRecurringPayment> {
  const response = await fetch(
    `/api/dashboard/payments/recurring-payments/${encodeURIComponent(
      recurringPaymentId
    )}/${action}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
      signal,
    }
  );
  const data = await readDashboardEnvelope<
    PaymentRecurringPaymentResponse | PaymentRecurringPaymentCollectionResponse
  >(
    response,
    dashboardRecurringPaymentEnvelopeSchema,
    t("DashboardPayments.recurring.actionFailed"),
    t
  );
  return data.recurringPayment;
}

export async function fetchRecurringPayments(
  request: SdpApiClient["request"],
  t: Translate,
  options: RecurringPaymentsListOptions
): Promise<RecurringFetchResult<ListPaymentRecurringPaymentsResponse>> {
  try {
    const query = buildRecurringPaymentsQuery({
      page: options.page ?? 1,
      pageSize: options.pageSize ?? RECURRING_PAYMENTS_PAGE_SIZE,
      status: options.status,
      counterpartyId: options.counterpartyId,
    });
    const response = await request(`/v1/payments/recurring-payments?${query.toString()}`);
    if (!response.ok) {
      return {
        ok: false,
        status: response.status,
        error: parsePaymentApiErrorText(await response.text()),
      };
    }

    const json = recurringPaymentsListEnvelopeSchema.parse(await response.json());
    return { ok: true, data: json.data };
  } catch (error) {
    return {
      ok: false,
      status: null,
      error: error instanceof Error ? error.message : t("DashboardPayments.recurring.unableToLoad"),
    };
  }
}

export async function fetchRecurringPaymentById(
  request: SdpApiClient["request"],
  recurringPaymentId: string,
  t: Translate
): Promise<RecurringFetchResult<PaymentRecurringPayment>> {
  try {
    const response = await request(
      `/v1/payments/recurring-payments/${encodeURIComponent(recurringPaymentId)}`
    );
    if (!response.ok) {
      return {
        ok: false,
        status: response.status,
        error: parsePaymentApiErrorText(await response.text()),
      };
    }

    const json = recurringPaymentEnvelopeSchema.parse(await response.json());
    return { ok: true, data: json.data.recurringPayment };
  } catch (error) {
    return {
      ok: false,
      status: null,
      error: error instanceof Error ? error.message : t("DashboardPayments.recurring.unableToLoad"),
    };
  }
}

export async function fetchRecurringPaymentCollectionAttempts(
  request: SdpApiClient["request"],
  subscriptionId: string,
  t: Translate
): Promise<RecurringFetchResult<RecurringPaymentCollectionAttemptsResult>> {
  try {
    const response = await request(
      `/v1/payments/subscriptions/${encodeURIComponent(
        subscriptionId
      )}/collection-attempts?page=1&pageSize=25`
    );
    if (!response.ok) {
      return {
        ok: false,
        status: response.status,
        error: parsePaymentApiErrorText(await response.text()),
      };
    }

    const json = collectionAttemptsEnvelopeSchema.parse(await response.json());
    return {
      ok: true,
      data: {
        collectionAttempts: json.data.collectionAttempts,
        total: json.data.total,
      },
    };
  } catch (error) {
    return {
      ok: false,
      status: null,
      error:
        error instanceof Error
          ? error.message
          : t("DashboardPayments.recurring.unableToLoadCollectionHistory", { error: "" }),
    };
  }
}
