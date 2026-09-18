import {
  type ApprovalRequestStatus,
  WALLET_OPERATION_FAMILIES,
  type WalletApprovalRequestSummary,
  type WalletOperationFamily,
} from "@sdp/types";

export const APPROVAL_INBOX_PAGE_SIZE = 25;

export const APPROVAL_OPERATION_FAMILIES = WALLET_OPERATION_FAMILIES;

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
  if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) {
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

/**
 * What running an approved request's operation did. Approving runs the
 * operation inside the same API call, so an approved request is normally
 * already `succeeded` or `failed`. `running` covers an attempt that has not
 * finished, including an interrupted one the recovery job has yet to retry or
 * fail. `not_run` is an approval whose operation was no longer pending
 * approval when it was approved, so it was never claimed for execution.
 */
export type ApprovalExecutionState = "succeeded" | "failed" | "running" | "not_run";

/** @returns The execution outcome for an approved request, or null for any other status. */
export function approvalExecutionState(
  request: WalletApprovalRequestSummary
): ApprovalExecutionState | null {
  if (request.status !== "approved") return null;
  switch (request.operation.status) {
    case "completed":
      return "succeeded";
    case "failed":
      return "failed";
    case "executing":
      return "running";
    case "created":
    case "evaluated":
    case "pending_approval":
    case "canceled":
      return "not_run";
  }
}

/**
 * The status a request's badge shows. An approval whose execution failed did
 * not do what was approved, so it must not read as a green "Approved".
 */
export type ApprovalBadgeStatus = ApprovalRequestStatus | "execution_failed";

export function approvalBadgeStatus(request: WalletApprovalRequestSummary): ApprovalBadgeStatus {
  return approvalExecutionState(request) === "failed" ? "execution_failed" : request.status;
}

export function hasApprovalFilters(filters: ApprovalInboxFilters): boolean {
  return Object.values(filters).some(Boolean);
}

export function formatApprovalLabel(value: string): string {
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
