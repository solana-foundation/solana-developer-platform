import type {
  ApprovalRequestStatus,
  WalletApprovalRequestSummary,
  WalletOperationFamily,
} from "@sdp/types";

export const APPROVAL_INBOX_PAGE_SIZE = 25;

export const APPROVAL_OPERATION_FAMILIES = [
  "transfer",
  "payment",
  "ramp",
  "issuance",
  "raw_sign",
  "program",
  "provider_admin",
] as const satisfies readonly WalletOperationFamily[];

export const APPROVAL_HISTORY_STATUSES = [
  "approved",
  "rejected",
  "canceled",
  "expired",
  "failed",
] as const satisfies readonly ApprovalRequestStatus[];

export type ApprovalInboxTab = "pending" | "history";

export interface ApprovalInboxFilters {
  walletId: string;
  status: "" | ApprovalRequestStatus;
  operationFamily: "" | WalletOperationFamily;
  apiKeyId: string;
  from: string;
  to: string;
}

export const EMPTY_APPROVAL_FILTERS: ApprovalInboxFilters = {
  walletId: "",
  status: "",
  operationFamily: "",
  apiKeyId: "",
  from: "",
  to: "",
};

const APPROVAL_LABEL_OVERRIDES: Readonly<Record<string, string>> = {
  raw_sign: "Raw signing",
  program: "Program operations",
  provider_admin: "Provider administration",
};

export function mergeApprovalRequests(
  ...requestGroups: WalletApprovalRequestSummary[][]
): WalletApprovalRequestSummary[] {
  return [...new Map(requestGroups.flat().map((request) => [request.id, request])).values()];
}

function localDateBoundary(value: string, endOfDay: boolean): number | null {
  const [year, month, day] = value.split("-").map(Number);
  if (!year || !month || !day) return null;

  const date = endOfDay
    ? new Date(year, month - 1, day, 23, 59, 59, 999)
    : new Date(year, month - 1, day);
  if (
    date.getFullYear() !== year ||
    date.getMonth() !== month - 1 ||
    date.getDate() !== day
  ) {
    return null;
  }
  return date.getTime();
}

function startsAt(value: string): number | null {
  if (!value) return null;
  return localDateBoundary(value, false);
}

function endsAt(value: string): number | null {
  if (!value) return null;
  return localDateBoundary(value, true);
}

export function filterApprovalRequests(
  requests: WalletApprovalRequestSummary[],
  tab: ApprovalInboxTab,
  filters: ApprovalInboxFilters
): WalletApprovalRequestSummary[] {
  const from = startsAt(filters.from);
  const to = endsAt(filters.to);

  return requests
    .filter((request) =>
      tab === "pending" ? request.status === "pending" : request.status !== "pending"
    )
    .filter((request) => !filters.walletId || request.operation.walletId === filters.walletId)
    .filter((request) => !filters.status || request.status === filters.status)
    .filter(
      (request) =>
        !filters.operationFamily || request.operation.operationFamily === filters.operationFamily
    )
    .filter((request) => !filters.apiKeyId || request.operation.apiKeyId === filters.apiKeyId)
    .filter((request) => {
      const submittedAt = Date.parse(request.createdAt);
      if (Number.isNaN(submittedAt)) return false;
      if (from !== null && submittedAt < from) return false;
      if (to !== null && submittedAt > to) return false;
      return true;
    })
    .sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt));
}

export function hasApprovalFilters(filters: ApprovalInboxFilters): boolean {
  return Object.values(filters).some(Boolean);
}

export function formatApprovalLabel(value: string): string {
  const override = APPROVAL_LABEL_OVERRIDES[value];
  if (override) return override;

  return value
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[_\s-]+/)
    .filter(Boolean)
    .map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1)}`)
    .join(" ");
}

export function shortApprovalIdentifier(value: string | null | undefined, edge = 6): string {
  if (!value) return "-";
  if (value.length <= edge * 2 + 3) return value;
  return `${value.slice(0, edge)}...${value.slice(-edge)}`;
}

export function approvalWalletLabel(request: WalletApprovalRequestSummary): string {
  return (
    request.wallet?.label?.trim() ||
    shortApprovalIdentifier(request.wallet?.publicKey ?? request.operation.walletId)
  );
}

export function approvalApiKeyLabel(
  request: WalletApprovalRequestSummary,
  apiKeyNames: Record<string, string>,
  directRequestLabel: string
): string {
  const apiKeyId = request.operation.apiKeyId;
  if (!apiKeyId) {
    return request.requestedBy ? shortApprovalIdentifier(request.requestedBy) : directRequestLabel;
  }
  return apiKeyNames[apiKeyId] || shortApprovalIdentifier(apiKeyId);
}

export function approvalReason(
  request: WalletApprovalRequestSummary,
  approvalRequiredLabel: string
): string {
  return (
    request.policyEvaluation?.reason ||
    (request.policyEvaluation?.reasonCode
      ? formatApprovalLabel(request.policyEvaluation.reasonCode)
      : approvalRequiredLabel)
  );
}

export function approvalAmount(request: WalletApprovalRequestSummary): string {
  const { amount, asset } = request.operation;
  if (!amount && !asset) return "-";
  return [amount, asset].filter(Boolean).join(" ");
}

export function formatApprovalDateTime(value: string | null, locale: string): string {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat(locale, {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
}

export function formatApprovalRelativeTime(
  value: string,
  locale: string,
  now = Date.now()
): string {
  const timestamp = Date.parse(value);
  if (Number.isNaN(timestamp)) return value;
  const seconds = Math.round((timestamp - now) / 1000);
  const absoluteSeconds = Math.abs(seconds);
  const formatter = new Intl.RelativeTimeFormat(locale, { numeric: "auto" });

  if (absoluteSeconds < 60) return formatter.format(seconds, "second");
  const minutes = Math.round(seconds / 60);
  if (Math.abs(minutes) < 60) return formatter.format(minutes, "minute");
  const hours = Math.round(minutes / 60);
  if (Math.abs(hours) < 24) return formatter.format(hours, "hour");
  const days = Math.round(hours / 24);
  if (Math.abs(days) < 30) return formatter.format(days, "day");
  return formatApprovalDateTime(value, locale);
}
