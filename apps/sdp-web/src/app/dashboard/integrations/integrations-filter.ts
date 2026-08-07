import type { IntegrationStatus } from "./integrations-status";

export type IntegrationFamily = "custody" | "rpc" | "ramps" | "compliance";

export const INTEGRATION_FAMILIES: IntegrationFamily[] = ["custody", "rpc", "ramps", "compliance"];

export type FamilyFilter = IntegrationFamily | "all";
export type StatusFilter = IntegrationStatus | "all";

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
  if (filters.status !== "all" && row.status !== filters.status) {
    return false;
  }
  const query = filters.query.trim().toLowerCase();
  if (query.length === 0) {
    return true;
  }
  return row.label.toLowerCase().includes(query) || row.provider.toLowerCase().includes(query);
}

export function hasActiveFilters(filters: IntegrationFilters): boolean {
  return filters.family !== "all" || filters.status !== "all" || filters.query.trim().length > 0;
}

export function countByFamily(
  rows: readonly FilterableIntegration[]
): Record<IntegrationFamily, number> {
  const counts: Record<IntegrationFamily, number> = {
    custody: 0,
    rpc: 0,
    ramps: 0,
    compliance: 0,
  };
  for (const row of rows) {
    counts[row.family] += 1;
  }
  return counts;
}
