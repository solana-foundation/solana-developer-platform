import type {
  CustodyWalletByIdResponse,
  ListApiKeysResponse,
  PolicyDecision,
  WalletControlProfileRevisionHistory,
  WalletOperationFamily,
  WalletOperationStatus,
  WalletPolicyEvaluationDetail,
} from "@sdp/types";
import type { SdpApiClient } from "@/lib/sdp-api";

export const POLICY_AUDIT_PAGE_SIZE = 25;
const POLICY_AUDIT_API_PAGE_SIZE = 100;
const POLICY_AUDIT_MAX_LOCAL_FILTER_PAGES = 50;

const POLICY_DECISIONS = [
  "allow",
  "deny",
  "approval_required",
  "provider_approval_required",
  "review",
  "not_evaluated",
] as const satisfies readonly PolicyDecision[];

export const POLICY_AUDIT_OPERATION_STATUSES = [
  "created",
  "evaluated",
  "pending_approval",
  "executing",
  "completed",
  "failed",
  "canceled",
] as const satisfies readonly WalletOperationStatus[];

export const POLICY_AUDIT_OPERATION_FAMILIES = [
  "transfer",
  "payment",
  "ramp",
  "issuance",
  "raw_sign",
  "program",
  "provider_admin",
] as const satisfies readonly WalletOperationFamily[];

export interface PolicyAuditFilters {
  page: number;
  decision?: PolicyDecision;
  status?: WalletOperationStatus;
  operationFamily?: WalletOperationFamily;
  reasonCode?: string;
  from?: string;
  to?: string;
}

export interface PolicyAuditListResult {
  evaluations: WalletPolicyEvaluationDetail[];
  total: number;
  page: number;
  pageSize: number;
}

export interface PolicyAuditContext {
  wallet: CustodyWalletByIdResponse["wallet"];
  revisionHistory: WalletControlProfileRevisionHistory;
  apiKeyNames: Record<string, string>;
}

export interface PolicyAuditNeighbor {
  id: string;
  page: number;
}

export interface PolicyAuditNeighbors {
  previous: PolicyAuditNeighbor | null;
  next: PolicyAuditNeighbor | null;
}

type SearchParams = Record<string, string | string[] | undefined>;
type AuditApiMeta = {
  total: number;
  page: number;
  pageSize: number;
  hasMore: boolean;
};

interface AuditApiPage {
  data: WalletPolicyEvaluationDetail[];
  meta: AuditApiMeta;
}

export class PolicyAuditRequestError extends Error {
  constructor(
    message: string,
    readonly status: number
  ) {
    super(message);
    this.name = "PolicyAuditRequestError";
  }
}

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function enumValue<T extends string>(
  value: string | undefined,
  values: readonly T[]
): T | undefined {
  return value && values.includes(value as T) ? (value as T) : undefined;
}

function dateValue(value: string | undefined): string | undefined {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return undefined;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value
    ? undefined
    : value;
}

export function parsePolicyAuditFilters(searchParams: SearchParams): PolicyAuditFilters {
  const parsedPage = Number.parseInt(first(searchParams.page) ?? "1", 10);
  return {
    page: Number.isInteger(parsedPage) && parsedPage > 0 ? parsedPage : 1,
    decision: enumValue(first(searchParams.decision), POLICY_DECISIONS),
    status: enumValue(first(searchParams.status), POLICY_AUDIT_OPERATION_STATUSES),
    operationFamily: enumValue(
      first(searchParams.operationFamily),
      POLICY_AUDIT_OPERATION_FAMILIES
    ),
    reasonCode: first(searchParams.reasonCode)?.trim().slice(0, 100) || undefined,
    from: dateValue(first(searchParams.from)),
    to: dateValue(first(searchParams.to)),
  };
}

export function hasPolicyAuditFilters(filters: PolicyAuditFilters): boolean {
  return Boolean(
    filters.decision ||
      filters.status ||
      filters.operationFamily ||
      filters.reasonCode ||
      filters.from ||
      filters.to
  );
}

export function buildPolicyAuditSearchParams(
  filters: PolicyAuditFilters,
  overrides: Partial<PolicyAuditFilters> = {}
): URLSearchParams {
  const values = { ...filters, ...overrides };
  const query = new URLSearchParams();
  if (values.page > 1) query.set("page", String(values.page));
  if (values.decision) query.set("decision", values.decision);
  if (values.status) query.set("status", values.status);
  if (values.operationFamily) query.set("operationFamily", values.operationFamily);
  if (values.reasonCode) query.set("reasonCode", values.reasonCode);
  if (values.from) query.set("from", values.from);
  if (values.to) query.set("to", values.to);
  return query;
}

function buildPolicyAuditApiQuery(
  filters: Omit<PolicyAuditFilters, "from" | "to">,
  page: number,
  pageSize: number,
  decision = filters.decision
): URLSearchParams {
  const query = new URLSearchParams({ page: String(page), pageSize: String(pageSize) });
  if (decision) query.set("decision", decision);
  if (filters.status) query.set("status", filters.status);
  if (filters.operationFamily) query.set("operationFamily", filters.operationFamily);
  if (filters.reasonCode) query.set("reasonCode", filters.reasonCode);
  return query;
}

async function readError(response: Response): Promise<string> {
  const body = (await response.json().catch(() => null)) as {
    error?: { message?: string } | string;
    message?: string;
  } | null;
  if (typeof body?.error === "string") return body.error;
  return body?.error?.message ?? body?.message ?? `Request failed (${response.status})`;
}

async function requestAuditPage(
  request: SdpApiClient["request"],
  walletId: string,
  filters: PolicyAuditFilters,
  page: number,
  pageSize: number,
  decision = filters.decision
): Promise<AuditApiPage> {
  const query = buildPolicyAuditApiQuery(filters, page, pageSize, decision);
  const response = await request(
    `/v1/payments/wallets/${encodeURIComponent(walletId)}/policies/evaluations?${query}`
  );
  if (!response.ok) {
    throw new PolicyAuditRequestError(await readError(response), response.status);
  }

  const body = (await response.json()) as Partial<AuditApiPage>;
  return {
    data: body.data ?? [],
    meta: body.meta ?? {
      total: body.data?.length ?? 0,
      page,
      pageSize,
      hasMore: false,
    },
  };
}

function evaluationIsInDateRange(
  evaluation: WalletPolicyEvaluationDetail,
  filters: Pick<PolicyAuditFilters, "from" | "to">
): boolean {
  const timestamp = Date.parse(evaluation.evaluatedAt);
  if (Number.isNaN(timestamp)) return false;
  if (filters.from && timestamp < Date.parse(`${filters.from}T00:00:00.000Z`)) return false;
  if (filters.to && timestamp > Date.parse(`${filters.to}T23:59:59.999Z`)) return false;
  return true;
}

async function collectPolicyEvaluations(
  request: SdpApiClient["request"],
  walletId: string,
  filters: PolicyAuditFilters,
  decision: PolicyDecision | undefined
): Promise<WalletPolicyEvaluationDetail[]> {
  const evaluations: WalletPolicyEvaluationDetail[] = [];
  let page = 1;

  while (true) {
    const result = await requestAuditPage(
      request,
      walletId,
      filters,
      page,
      POLICY_AUDIT_API_PAGE_SIZE,
      decision
    );
    evaluations.push(...result.data.filter((item) => evaluationIsInDateRange(item, filters)));

    const fromTimestamp = filters.from
      ? Date.parse(`${filters.from}T00:00:00.000Z`)
      : Number.NEGATIVE_INFINITY;
    const reachedLowerBound = result.data.some(
      (item) => Date.parse(item.evaluatedAt) < fromTimestamp
    );
    const pageCount = Math.max(1, Math.ceil(result.meta.total / Math.max(1, result.meta.pageSize)));
    if (!result.meta.hasMore || reachedLowerBound || page >= pageCount) break;
    if (page >= POLICY_AUDIT_MAX_LOCAL_FILTER_PAGES) {
      throw new PolicyAuditRequestError(
        "Policy audit history exceeds the local filtering limit",
        422
      );
    }
    page += 1;
  }

  return evaluations;
}

export async function fetchPolicyAuditList(
  request: SdpApiClient["request"],
  walletId: string,
  filters: PolicyAuditFilters
): Promise<PolicyAuditListResult> {
  const needsLocalPagination = Boolean(
    filters.from || filters.to || filters.decision === "approval_required"
  );
  if (!needsLocalPagination) {
    const result = await requestAuditPage(
      request,
      walletId,
      filters,
      filters.page,
      POLICY_AUDIT_PAGE_SIZE
    );
    return {
      evaluations: result.data,
      total: result.meta.total,
      page: filters.page,
      pageSize: POLICY_AUDIT_PAGE_SIZE,
    };
  }

  const decisions: Array<PolicyDecision | undefined> =
    filters.decision === "approval_required"
      ? ["approval_required", "provider_approval_required"]
      : [filters.decision];
  const pages = await Promise.all(
    decisions.map((decision) => collectPolicyEvaluations(request, walletId, filters, decision))
  );
  const evaluations = pages
    .flat()
    .sort((left, right) => Date.parse(right.evaluatedAt) - Date.parse(left.evaluatedAt));
  const pageCount = Math.max(1, Math.ceil(evaluations.length / POLICY_AUDIT_PAGE_SIZE));
  const page = Math.min(filters.page, pageCount);
  const start = (page - 1) * POLICY_AUDIT_PAGE_SIZE;

  return {
    evaluations: evaluations.slice(start, start + POLICY_AUDIT_PAGE_SIZE),
    total: evaluations.length,
    page,
    pageSize: POLICY_AUDIT_PAGE_SIZE,
  };
}

async function fetchWallet(
  request: SdpApiClient["request"],
  walletId: string
): Promise<CustodyWalletByIdResponse["wallet"]> {
  const response = await request(`/v1/wallets/${encodeURIComponent(walletId)}`);
  if (!response.ok) {
    throw new PolicyAuditRequestError(await readError(response), response.status);
  }
  const body = (await response.json()) as { data?: CustodyWalletByIdResponse };
  if (!body.data?.wallet) {
    throw new PolicyAuditRequestError("Wallet not found", 404);
  }
  return body.data.wallet;
}

async function fetchRevisionHistory(
  request: SdpApiClient["request"],
  walletId: string
): Promise<WalletControlProfileRevisionHistory> {
  const response = await request(
    `/v1/payments/wallets/${encodeURIComponent(walletId)}/policies/revisions`
  );
  if (!response.ok) {
    throw new PolicyAuditRequestError(await readError(response), response.status);
  }
  const body = (await response.json()) as { data?: WalletControlProfileRevisionHistory };
  return body.data ?? { profile: null, revisions: [] };
}

async function fetchApiKeyNames(request: SdpApiClient["request"]): Promise<Record<string, string>> {
  try {
    const response = await request("/v1/api-keys");
    if (!response.ok) return {};
    const body = (await response.json()) as { data?: ListApiKeysResponse };
    return Object.fromEntries((body.data?.apiKeys ?? []).map((key) => [key.id, key.name]));
  } catch {
    return {};
  }
}

export async function fetchPolicyAuditContext(
  request: SdpApiClient["request"],
  walletId: string
): Promise<PolicyAuditContext> {
  const [wallet, revisionHistory, apiKeyNames] = await Promise.all([
    fetchWallet(request, walletId),
    fetchRevisionHistory(request, walletId),
    fetchApiKeyNames(request),
  ]);
  return { wallet, revisionHistory, apiKeyNames };
}

export async function fetchPolicyEvaluation(
  request: SdpApiClient["request"],
  walletId: string,
  policyEvaluationId: string
): Promise<WalletPolicyEvaluationDetail> {
  const response = await request(
    `/v1/payments/wallets/${encodeURIComponent(walletId)}/policies/evaluations/${encodeURIComponent(policyEvaluationId)}`
  );
  if (!response.ok) {
    throw new PolicyAuditRequestError(await readError(response), response.status);
  }
  const body = (await response.json()) as {
    data?: { policyEvaluation?: WalletPolicyEvaluationDetail };
  };
  if (!body.data?.policyEvaluation) {
    throw new PolicyAuditRequestError("Policy evaluation not found", 404);
  }
  return body.data.policyEvaluation;
}

export async function fetchPolicyEvaluationNeighbors(
  request: SdpApiClient["request"],
  walletId: string,
  policyEvaluationId: string,
  filters: PolicyAuditFilters
): Promise<PolicyAuditNeighbors> {
  const current = await fetchPolicyAuditList(request, walletId, filters);
  const index = current.evaluations.findIndex((item) => item.id === policyEvaluationId);
  if (index === -1) return { previous: null, next: null };

  let previous = index > 0 ? { id: current.evaluations[index - 1].id, page: current.page } : null;
  let next =
    index < current.evaluations.length - 1
      ? { id: current.evaluations[index + 1].id, page: current.page }
      : null;

  if (!previous && current.page > 1) {
    const page = current.page - 1;
    const adjacent = await fetchPolicyAuditList(request, walletId, { ...filters, page });
    const evaluation = adjacent.evaluations.at(-1);
    previous = evaluation ? { id: evaluation.id, page } : null;
  }
  if (!next && current.page * current.pageSize < current.total) {
    const page = current.page + 1;
    const adjacent = await fetchPolicyAuditList(request, walletId, { ...filters, page });
    const evaluation = adjacent.evaluations[0];
    next = evaluation ? { id: evaluation.id, page } : null;
  }

  return { previous, next };
}
