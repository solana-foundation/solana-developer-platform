import type { IntegrationStatus } from "./integrations-status";

export type IntegrationFamily = "custody" | "ramps" | "compliance" | "privacy";

export const INTEGRATION_FAMILIES: IntegrationFamily[] = [
  "custody",
  "ramps",
  "compliance",
  "privacy",
];

export type FamilyFilter = IntegrationFamily | "all";

/**
 * What a reader is actually asking when they filter: is this thing on or not.
 * `active` and `enabled` both mean "running", differing only in whether the
 * switch is per project or deployment-wide; that distinction belongs on the
 * detail page, not in a chip.
 */
export type ConnectionState = "connected" | "not_connected" | "unknown";

export const CONNECTION_STATE_BY_STATUS: Record<IntegrationStatus, ConnectionState> = {
  active: "connected",
  enabled: "connected",
  available: "not_connected",
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
export const STATUS_FILTERS = ["all", "connected", "not_connected"] as const;

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
