import type { IntegrationStatus } from "./integrations-status";

export type IntegrationFamily = "custody" | "rpc" | "ramps" | "compliance" | "privacy";

export const INTEGRATION_FAMILIES: IntegrationFamily[] = [
  "custody",
  "rpc",
  "ramps",
  "compliance",
  "privacy",
];

export type FamilyFilter = IntegrationFamily | "all";

/**
 * What a reader is actually asking when they filter: is this thing on, is it
 * not, or does getting it require asking someone.
 *
 * Six statuses answered three questions, and two of the chips split hairs the
 * page never needed to draw -- `available` and `not_configured` both mean "not
 * running", and `active` and `enabled` both mean "running", differing only in
 * whether the switch is per organization or deployment-wide. That distinction
 * is real in the data and belongs on the detail page; as a filter it produced
 * a "Connected" chip that hid providers the catalog had just painted as
 * connected.
 */
export type ConnectionState = "connected" | "not_connected" | "on_request" | "unknown";

export const CONNECTION_STATE_BY_STATUS: Record<IntegrationStatus, ConnectionState> = {
  active: "connected",
  enabled: "connected",
  available: "not_connected",
  not_configured: "not_connected",
  request_access: "on_request",
  unknown: "unknown",
};

export function connectionState(status: IntegrationStatus): ConnectionState {
  return CONNECTION_STATE_BY_STATUS[status];
}

/**
 * `unknown` is deliberately not offered: a row whose state could not be read is
 * not a category anyone browses for, and a chip that usually matches nothing
 * reads as broken.
 */
export const STATUS_FILTERS = ["all", "connected", "not_connected", "on_request"] as const;

export type StatusFilter = (typeof STATUS_FILTERS)[number];

export interface FilterableIntegration {
  family: IntegrationFamily;
  /** Stable id used as the React key and matched by search alongside the label. */
  provider: string;
  label: string;
  status: IntegrationStatus;
}

export interface IntegrationFilters {
  family: FamilyFilter;
  status: StatusFilter;
  query: string;
}

export const NO_FILTERS: IntegrationFilters = { family: "all", status: "all", query: "" };

export function matchesFilters(row: FilterableIntegration, filters: IntegrationFilters): boolean {
  if (filters.family !== "all" && row.family !== filters.family) {
    return false;
  }
  if (filters.status !== "all" && connectionState(row.status) !== filters.status) {
    return false;
  }
  const query = filters.query.trim().toLowerCase();
  if (query.length === 0) {
    return true;
  }
  return row.label.toLowerCase().includes(query) || row.provider.toLowerCase().includes(query);
}
