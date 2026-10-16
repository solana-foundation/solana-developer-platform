/** The Overview's Solana network readings: the contract between the API that derives them from
 * data.solana.com and the dashboard that draws them. */
import { z } from "zod";

export const NETWORK_METRIC_IDS = [
  "stablecoinSupply",
  "stablecoinTransfers",
  "stablecoinShare",
  "costPerTransaction",
] as const;
export type NetworkMetricId = (typeof NETWORK_METRIC_IDS)[number];

/** The mainnet cluster's state on status.solana.com, folded to what the Overview tells apart. */
export const NETWORK_HEALTH_STATES = ["operational", "degraded", "outage", "maintenance"] as const;
export type NetworkHealth = (typeof NETWORK_HEALTH_STATES)[number];

/** The states a Statuspage component reports on status.solana.com. */
export const STATUSPAGE_COMPONENT_STATUSES = [
  "operational",
  "degraded_performance",
  "partial_outage",
  "major_outage",
  "under_maintenance",
] as const;
export type StatuspageComponentStatus = (typeof STATUSPAGE_COMPONENT_STATUSES)[number];

/** Each Statuspage state as the Overview's badge tells it. */
export const NETWORK_HEALTH_BY_STATUSPAGE_STATUS = {
  operational: "operational",
  degraded_performance: "degraded",
  partial_outage: "outage",
  major_outage: "outage",
  under_maintenance: "maintenance",
} as const satisfies Record<StatuspageComponentStatus, NetworkHealth>;

export const networkPointSchema = z.object({
  /** UTC calendar day, YYYY-MM-DD. */
  date: z.iso.date(),
  value: z.number().finite(),
});
export type NetworkPoint = z.infer<typeof networkPointSchema>;

/**
 * One series per reading, keyed by its id: every id exactly once, so the Overview always draws the
 * same four figures. A series holds one reading per UTC day, oldest first, ending on the
 * snapshot's `asOf`, and is empty when the source had no complete day for the reading.
 */
export const networkMetricsSchema = z.record(
  z.enum(NETWORK_METRIC_IDS),
  z.array(networkPointSchema)
);
export type NetworkMetrics = z.infer<typeof networkMetricsSchema>;

export const networkSnapshotSchema = z.object({
  /** The latest complete UTC day: every reading is that day's close, never a partial day. */
  asOf: z.iso.date(),
  /** The cluster's state and when status.solana.com reported it; null when it could not be
   * read. The Overview drops a reading too old to stand for now. */
  health: z
    .object({ state: z.enum(NETWORK_HEALTH_STATES), checkedAt: z.iso.datetime() })
    .nullable(),
  metrics: networkMetricsSchema,
});
export type NetworkSnapshot = z.infer<typeof networkSnapshotSchema>;
export type NetworkHealthReading = NonNullable<NetworkSnapshot["health"]>;
