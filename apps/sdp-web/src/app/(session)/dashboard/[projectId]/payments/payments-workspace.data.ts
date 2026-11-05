"use client";

import { compareDecimalAmounts, isDecimalString } from "@sdp/solana/amount";
import type { Counterparty } from "@sdp/types/counterparties";
import { STAGED_PROVIDER_REFUSAL_REASONS } from "@sdp/types/custody";
import { RAMP_FIAT_CURRENCIES } from "@sdp/types/generated/ramp";
import { CRYPTO_RAIL_ASSET_LABELS, SOLANA_CRYPTO_RAILS } from "@sdp/types/payment-rails";
import {
  type ListProjectCounterpartyAccountsEnvelope,
  type ListProjectCounterpartyAccountsResponse,
  type PaymentTransferBatch,
  type PaymentTransferBatchEnvelope,
  type PaymentTransferBatchRequest,
  type PaymentTransferRecipient,
  RAMP_AMOUNT_LIMIT_REASONS,
  RAMP_DIRECTIONS,
  type RampProviderEstimateResult,
  type PaymentTransferEnvelope as TransferEnvelope,
  type PaymentTransferSummary as TransferRecord,
} from "@sdp/types/payments";
// biome-ignore lint/style/noRestrictedImports: validates the provider ids an estimate response names; which providers to ask comes from getEnabledRampProviders()
import { RAMP_PROVIDERS } from "@sdp/types/provider-access";
import type { Address } from "@solana/kit";
import { z } from "zod";
import type { MessageKey } from "@/i18n/messages";
import type { TranslationValues } from "@/i18n/translate";
import {
  type ComplianceIntent,
  type ComplianceProviderResult,
  screenAddressCompliance,
} from "@/lib/compliance";
import {
  type CallerIdempotencyKey,
  dashboardRequest,
  dashboardRequestUnderOwnKey,
} from "@/lib/dashboard-fetch";
import type { DashboardPostReadKey } from "@/lib/dashboard-request-key";
import { readDashboardPostRequest } from "@/lib/dashboard-swr";
import { apiErrorCode } from "@/lib/idempotency";
import {
  type PaymentApiErrorBody as ApiErrorBody,
  getPaymentApiError as getApiError,
  paymentApiErrorBodySchema,
} from "./payment-api-errors";
import type { ComplianceSnapshot } from "./payments-workspace.types";

export type RiskTone = "green" | "yellow" | "red" | "neutral";
export type Translate = (key: MessageKey, values?: TranslationValues) => string;

export function toProviderLabel(value: string): string {
  const labels: Record<string, string> = {
    range: "Range",
    elliptic: "Elliptic",
    trm: "TRM",
    chainalysis: "Chainalysis",
  };
  return labels[value] ?? value.toUpperCase();
}

export function formatRiskScore(result: ComplianceProviderResult, t: Translate): string {
  if (
    typeof result.riskScore === "number" &&
    typeof result.riskLevel === "string" &&
    result.riskLevel
  ) {
    return `${result.riskScore} - ${result.riskLevel}`;
  }
  if (typeof result.riskScore === "number") {
    return String(result.riskScore);
  }
  if (
    result.provider === "trm" &&
    result.status === "ok" &&
    result.riskScore === null &&
    !result.riskLevel?.trim()
  ) {
    return t("DashboardPayments.providerRisk.noTrmAttribution");
  }
  if (result.status === "error" && typeof result.message === "string" && result.message) {
    return result.message;
  }
  if (result.status === "unavailable") {
    return t("DashboardPayments.providerRisk.unavailable");
  }
  if (result.status === "ok" && typeof result.riskLevel === "string" && result.riskLevel) {
    return result.riskLevel;
  }
  if (result.status === "error") {
    return t("DashboardPayments.providerRisk.error");
  }
  return t("DashboardPayments.providerRisk.notAvailable");
}

export function resolveRiskTone(result: ComplianceProviderResult): RiskTone {
  if (result.status !== "ok") {
    return "neutral";
  }

  if (result.provider === "elliptic" && result.riskLevel?.toLowerCase() === "check passed") {
    return "green";
  }

  if (result.provider === "trm" && result.riskScore === null && !result.riskLevel?.trim()) {
    return "green";
  }

  if (typeof result.riskScore === "number") {
    if (result.riskScore >= 7) {
      return "red";
    }
    if (result.riskScore >= 3) {
      return "yellow";
    }
    return "green";
  }

  const riskLevel = result.riskLevel?.toLowerCase() ?? "";
  if (!riskLevel) {
    return "neutral";
  }

  if (
    riskLevel.includes("severe") ||
    riskLevel.includes("high") ||
    riskLevel.includes("critical") ||
    riskLevel.includes("elevated")
  ) {
    return "red";
  }

  if (
    riskLevel.includes("medium") ||
    riskLevel.includes("moderate") ||
    riskLevel.includes("watch")
  ) {
    return "yellow";
  }

  if (
    riskLevel.includes("low") ||
    riskLevel.includes("very low") ||
    riskLevel.includes("none") ||
    riskLevel.includes("minimal")
  ) {
    return "green";
  }

  return "neutral";
}

/** Providers that flagged the address as high risk (red tone). */
export function getHighRiskProviders(snapshot: ComplianceSnapshot): ComplianceProviderResult[] {
  return snapshot.providers.filter((result) => resolveRiskTone(result) === "red");
}

export async function cancelRampTransfer(
  input: {
    transferId: string;
  },
  t: Translate
): Promise<void> {
  const response = await dashboardRequest("/api/dashboard/payments/ramps/transfers/cancel", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  const body = (await response.json()) as ApiErrorBody;
  if (!response.ok) {
    throw new Error(
      getApiError(
        body,
        t("DashboardPayments.workspace.transferCancellationFailed", { status: response.status })
      )
    );
  }
}

/** The estimates a ramp estimate key asks for, each with a rate it can show. */
export async function readRampEstimates(
  key: DashboardPostReadKey,
  t: Translate
): Promise<RampProviderEstimateResult[]> {
  const body = await readDashboardPostRequest(key, rampEstimateEnvelopeSchema);
  return body.data.estimates.map((result) => withUsableRate(result, t));
}

const rampEstimateCurrencySchema = z.union([
  z.enum(RAMP_FIAT_CURRENCIES),
  z.enum(CRYPTO_RAIL_ASSET_LABELS),
]);

/** Estimate figures are decimals; any other value refuses the response, as a missing one does. */
const rampFigureSchema = z.string().refine((value) => isDecimalString(value));

const rampEstimateSchema = z.object({
  provider: z.enum(RAMP_PROVIDERS),
  direction: z.enum(RAMP_DIRECTIONS),
  fiatCurrency: z.enum(RAMP_FIAT_CURRENCIES),
  assetRail: z.enum(SOLANA_CRYPTO_RAILS),
  fiatAmount: rampFigureSchema,
  cryptoAmount: rampFigureSchema,
  exchangeRate: rampFigureSchema,
  totalFiatAmount: rampFigureSchema.optional(),
  fees: z.object({
    currency: rampEstimateCurrencySchema,
    total: rampFigureSchema,
    network: rampFigureSchema.optional(),
    networkCurrency: rampEstimateCurrencySchema.optional(),
    provider: rampFigureSchema.optional(),
    providerCurrency: rampEstimateCurrencySchema.optional(),
  }),
  minFiatAmount: rampFigureSchema.optional(),
  maxFiatAmount: rampFigureSchema.optional(),
  expiresAt: z.string().optional(),
});

const rampProvider = z.enum(RAMP_PROVIDERS);

const rampProviderEstimateResultSchema = z.discriminatedUnion("status", [
  z.object({ provider: rampProvider, status: z.literal("ok"), estimate: rampEstimateSchema }),
  z.object({ provider: rampProvider, status: z.literal("unsupported") }),
  // A refusal names its reason; an amount out of range also names the bound it crossed.
  z.object({
    provider: rampProvider,
    status: z.literal("error"),
    error: z.string(),
    reason: z.enum([...RAMP_AMOUNT_LIMIT_REASONS, ...STAGED_PROVIDER_REFUSAL_REASONS]).optional(),
    limit: z.object({ amount: rampFigureSchema, currency: z.string() }).optional(),
  }),
]);

const rampEstimateEnvelopeSchema = z.object({
  data: z.object({ estimates: z.array(rampProviderEstimateResultSchema) }),
});

/** An estimate without a positive rate is that provider's error, never a figure to hide. */
function withUsableRate(
  result: RampProviderEstimateResult,
  t: Translate
): RampProviderEstimateResult {
  const rate = result.status === "ok" ? result.estimate.exchangeRate : null;
  if (rate === null || compareDecimalAmounts(rate, "0") > 0) {
    return result;
  }
  return {
    provider: result.provider,
    status: "error",
    error: t("DashboardPayments.workspace.rampEstimateInvalidRate"),
  };
}

export interface CreateTransferInput {
  transferId?: string;
  sourceCustodyWalletId: string;
  destination: string;
  /** The contact account `destination` belongs to, so the transfer is tied to that contact. */
  counterpartyAccountId?: string;
  token: Address;
  amount: string;
  memo?: string;
}

/**
 * An HTTP refusal from the transfer endpoint, carrying the status and the
 * replay mark so the caller can decide the idempotency key's fate on the
 * shared rule (`answerRetiresKey`).
 */
export class TransferRequestError extends Error {
  readonly status: number;
  readonly replayed: boolean;
  /** sdp-api's error code, or `null` when the body names none. */
  readonly code: string | null;

  constructor(message: string, status: number, replayed: boolean, code: string | null) {
    super(message);
    this.name = "TransferRequestError";
    this.status = status;
    this.replayed = replayed;
    this.code = code;
  }
}

/** Whether sdp-api answered from a stored result (relayed by the proxy). */
function isReplayed(response: Response): boolean {
  return response.headers.get("Idempotent-Replayed") === "true";
}

/**
 * A refusal's body, read once. A body that fails to download is no answer at
 * all, like a lost response (`unreadable` in `dashboard-fetch`): it throws a
 * plain error, never a request error with a status, so the caller keeps the
 * money key for the retry instead of retiring it on a refusal it never read.
 */
async function readRefusalText(response: Response, failedMessage: string): Promise<string> {
  try {
    return await response.text();
  } catch (error) {
    throw new Error(failedMessage, { cause: error });
  }
}

/** A readable refusal's error fields; a body that is not JSON, or not an object, has none. */
function parseRefusalBody(text: string): ApiErrorBody {
  let json: unknown;
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    return {};
  }
  const parsed = paymentApiErrorBodySchema.safeParse(json);
  return parsed.success ? parsed.data : {};
}

/**
 * Creates one transfer.
 *
 * The idempotency key is transport metadata, sent as a header and never in the
 * body; a key its store could not persist is refused (428) before anything is
 * sent. Null for a caller whose request is already single-shot (a ramp transfer
 * named by `transferId`), which `dashboardRequest` keys per user action.
 */
export async function createTransfer(
  input: CreateTransferInput,
  t: Translate,
  idempotencyKey: CallerIdempotencyKey | null
): Promise<TransferRecord> {
  const path = "/api/dashboard/payments/transfers";
  const init: RequestInit = {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      ...(input.transferId ? { transferId: input.transferId } : {}),
      sourceCustodyWalletId: input.sourceCustodyWalletId,
      destination: input.destination,
      // Left out of the body when absent: JSON.stringify drops an undefined value.
      counterpartyAccountId: input.counterpartyAccountId,
      token: input.token,
      amount: input.amount,
      ...(input.memo ? { memo: input.memo } : {}),
    }),
  };
  const response =
    idempotencyKey === null
      ? await dashboardRequest(path, init)
      : await dashboardRequestUnderOwnKey(path, init, idempotencyKey);
  if (!response.ok) {
    const text = await readRefusalText(
      response,
      t("DashboardPayments.workspace.transferRequestFailed", { status: response.status })
    );
    const code = apiErrorCode(text);
    const body = parseRefusalBody(text);
    throw new TransferRequestError(
      getApiError(
        body,
        t("DashboardPayments.workspace.transferRequestFailed", { status: response.status })
      ),
      response.status,
      isReplayed(response),
      code
    );
  }

  const body: unknown = await response.json().catch(() => null);
  // SAFETY: the transfer endpoint's success envelope is `PaymentTransferEnvelope`
  // (`@sdp/types`); only the presence of the transfer is checked here, as before.
  const envelope = body as TransferEnvelope | null;
  if (!envelope?.data?.transfer) {
    throw new Error(t("DashboardPayments.workspace.transferMissing"));
  }

  return envelope.data.transfer;
}

export async function fetchBatchRecipients(
  input: {
    page?: number;
    pageSize?: number;
    search?: string;
    ids?: string[];
    signal?: AbortSignal;
  },
  t: Translate
): Promise<ListProjectCounterpartyAccountsResponse> {
  const query = new URLSearchParams({
    ...(input.page ? { page: String(input.page) } : {}),
    ...(input.pageSize ? { pageSize: String(input.pageSize) } : {}),
    ...(input.search ? { search: input.search } : {}),
    ...(input.ids && input.ids.length > 0 ? { ids: input.ids.join(",") } : {}),
  });
  const response = await dashboardRequest(
    `/api/dashboard/counterparty/accounts?${query.toString()}`,
    {
      method: "GET",
      cache: "no-store",
      signal: input.signal,
    }
  );
  const body = (await response.json().catch(() => ({}))) as ListProjectCounterpartyAccountsEnvelope;
  if (!response.ok) {
    throw new Error(
      getApiError(
        body,
        t("DashboardPayments.workspace.recipientListRequestFailed", { status: response.status })
      )
    );
  }
  if (!body.data) {
    throw new Error(t("DashboardPayments.workspace.recipientListMissing"));
  }
  return body.data;
}

export interface CreateTransferBatchResult {
  batch: PaymentTransferBatch;
  recipients: PaymentTransferRecipient[];
  transfers: TransferRecord[];
}

/**
 * An HTTP refusal from the batch endpoint, carrying the status and the replay
 * mark so the caller can decide the idempotency key's fate on the shared rule
 * (`answerRetiresKey`). A network failure is a plain Error and keeps the key:
 * the API may have recorded the batch before the response was lost, and only
 * a replay with the SAME key can find out without moving the money again.
 */
export class TransferBatchRequestError extends Error {
  readonly status: number;
  readonly replayed: boolean;
  /** sdp-api's error code, or `null` when the body names none. */
  readonly code: string | null;

  constructor(message: string, status: number, replayed: boolean, code: string | null) {
    super(message);
    this.name = "TransferBatchRequestError";
    this.status = status;
    this.replayed = replayed;
    this.code = code;
  }
}

/**
 * The caller's idempotency key is transport metadata and is never copied into
 * the JSON body; the proxy route forwards that single header upstream. A key
 * its store could not persist is refused (428) before anything is sent.
 */
export async function createTransferBatch(
  input: PaymentTransferBatchRequest,
  t: Translate,
  idempotencyKey: CallerIdempotencyKey
): Promise<CreateTransferBatchResult> {
  const response = await dashboardRequestUnderOwnKey(
    "/api/dashboard/payments/transfers/batch",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    },
    idempotencyKey
  );
  return readTransferBatchAnswer(response, t);
}

/**
 * Sends a batch's failed recipients again (HOO-2343). The API sends only the
 * recipients that are failed when it runs, so a retry never pays a recipient
 * twice. The key is transport metadata, as for {@link createTransferBatch}.
 */
export async function retryTransferBatch(
  batchId: string,
  t: Translate,
  idempotencyKey: CallerIdempotencyKey
): Promise<CreateTransferBatchResult> {
  const response = await dashboardRequestUnderOwnKey(
    `/api/dashboard/payments/transfers/batch/${encodeURIComponent(batchId)}/retry`,
    { method: "POST" },
    idempotencyKey
  );
  return readTransferBatchAnswer(response, t);
}

async function readTransferBatchAnswer(
  response: Response,
  t: Translate
): Promise<CreateTransferBatchResult> {
  if (!response.ok) {
    const text = await readRefusalText(
      response,
      t("DashboardPayments.workspace.batchTransferRequestFailed", { status: response.status })
    );
    const code = apiErrorCode(text);
    const body = parseRefusalBody(text);
    throw new TransferBatchRequestError(
      getApiError(
        body,
        t("DashboardPayments.workspace.batchTransferRequestFailed", { status: response.status })
      ),
      response.status,
      isReplayed(response),
      code
    );
  }
  const body = (await response.json().catch(() => ({}))) as PaymentTransferBatchEnvelope;
  if (!body.data?.batch || !body.data.recipients || !body.data.transfers) {
    throw new Error(t("DashboardPayments.workspace.batchTransferMissing"));
  }
  return {
    batch: body.data.batch,
    recipients: body.data.recipients,
    transfers: body.data.transfers,
  };
}

type SandboxTransferSimulationInput = { transferId: string };

export async function simulateSandboxTransfer(
  input: SandboxTransferSimulationInput,
  t: Translate
): Promise<void> {
  const response = await dashboardRequest("/api/dashboard/payments/ramps/sandbox/simulate", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(input),
  });

  if (!response.ok) {
    throw new Error(
      getApiError(
        await response.json().catch(() => null),
        t("DashboardPayments.workspace.sandboxSimulationRequestFailed", {
          status: response.status,
        })
      )
    );
  }
}

export async function runComplianceCheck(
  address: string,
  intent: ComplianceIntent
): Promise<ComplianceSnapshot> {
  const result = await screenAddressCompliance({
    address,
    network: "solana",
    intent,
  });

  return {
    address,
    checkedAt: result.checkedAt,
    providers: result.providers.filter((provider) => provider.provider !== "chainalysis"),
  };
}

export interface CounterpartiesResult {
  ok: boolean;
  data: Counterparty[];
  /** The directory's full size, when the read knows it (a server's first page does). */
  total?: number;
  error?: string;
}
