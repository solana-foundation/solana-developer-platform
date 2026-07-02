import type {
  CreatePaymentRecurringPaymentRequest,
  ListPaymentRecurringPaymentsResponse,
  PaginatedResponse,
  PaymentRecurringPayment,
  PaymentRecurringPaymentCollectionResponse,
  PaymentRecurringPaymentResponse,
  PaymentRecurringPaymentStatus,
  UpdatePaymentRecurringPaymentRequest,
} from "@sdp/types";
import type { SdpApiClient } from "@/lib/sdp-api";
import { getPaymentApiError, parsePaymentApiErrorText } from "../payment-api-errors";
import type { FetchResult } from "../payments-page.data";

export const RECURRING_PAYMENTS_PAGE_SIZE = 100;

export type RecurringPaymentAction = "activate" | "collect" | "cancel" | "resume";

export interface RecurringPaymentsListOptions {
  page?: number;
  pageSize?: number;
  status?: PaymentRecurringPaymentStatus;
  counterpartyId?: string;
}

interface ClientRecurringPaymentsListOptions extends RecurringPaymentsListOptions {
  signal?: AbortSignal;
}

type DashboardApiEnvelope<T> = {
  data?: T;
  error?:
    | string
    | {
        message?: string;
      };
  message?: string;
};

function setPositiveInteger(query: URLSearchParams, key: string, value: number | undefined) {
  if (typeof value === "number" && Number.isInteger(value) && value > 0) {
    query.set(key, String(value));
  }
}

export function buildRecurringPaymentsQuery(
  options: RecurringPaymentsListOptions = {}
): URLSearchParams {
  const query = new URLSearchParams();
  setPositiveInteger(query, "page", options.page);
  setPositiveInteger(query, "pageSize", options.pageSize);
  if (options.status) {
    query.set("status", options.status);
  }
  if (options.counterpartyId) {
    query.set("counterpartyId", options.counterpartyId);
  }
  return query;
}

async function readDashboardEnvelope<T>(response: Response, fallback: string): Promise<T> {
  const body = (await response.json().catch(() => ({}))) as DashboardApiEnvelope<T>;
  if (!response.ok) {
    throw new Error(getPaymentApiError(body, `${fallback} (${response.status}).`));
  }
  if (!body.data) {
    throw new Error(`${fallback} returned an empty response.`);
  }
  return body.data;
}

export async function listRecurringPayments(
  options: ClientRecurringPaymentsListOptions = {}
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
    "Recurring payment list request failed"
  );
}

export async function getRecurringPayment(
  recurringPaymentId: string,
  signal?: AbortSignal
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
    "Recurring payment request failed"
  );
  return data.recurringPayment;
}

export async function createRecurringPayment(
  input: CreatePaymentRecurringPaymentRequest,
  signal?: AbortSignal
): Promise<PaymentRecurringPayment> {
  const response = await fetch("/api/dashboard/payments/recurring-payments", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
    signal,
  });
  const data = await readDashboardEnvelope<PaymentRecurringPaymentResponse>(
    response,
    "Recurring payment creation failed"
  );
  return data.recurringPayment;
}

export async function updateRecurringPayment(
  recurringPaymentId: string,
  input: UpdatePaymentRecurringPaymentRequest,
  signal?: AbortSignal
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
    "Recurring payment update failed"
  );
  return data.recurringPayment;
}

export async function runRecurringPaymentAction(
  recurringPaymentId: string,
  action: RecurringPaymentAction,
  signal?: AbortSignal
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
  >(response, "Recurring payment action failed");
  return data.recurringPayment;
}

export async function fetchRecurringPayments(
  request: SdpApiClient["request"],
  options: RecurringPaymentsListOptions = {}
): Promise<PaginatedResponse<PaymentRecurringPayment>> {
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
        data: [],
        total: 0,
        error: parsePaymentApiErrorText(await response.text()),
      };
    }

    const json = (await response.json()) as { data?: ListPaymentRecurringPaymentsResponse };
    return {
      ok: true,
      data: json.data?.recurringPayments ?? [],
      total: json.data?.total ?? 0,
    };
  } catch (error) {
    return {
      ok: false,
      data: [],
      total: 0,
      error: error instanceof Error ? error.message : "Unable to load recurring payments",
    };
  }
}

export async function fetchRecurringPaymentById(
  request: SdpApiClient["request"],
  recurringPaymentId: string
): Promise<FetchResult<PaymentRecurringPayment>> {
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

    const json = (await response.json()) as { data?: PaymentRecurringPaymentResponse };
    if (!json.data?.recurringPayment) {
      return {
        ok: false,
        error: "Recurring payment response is missing recurring payment details.",
      };
    }

    return { ok: true, data: json.data.recurringPayment };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : "Unable to load recurring payment",
    };
  }
}
