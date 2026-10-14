/**
 * An instance's outbound internet connectivity, as `/health/ready` reports it:
 * `pending` while a fresh instance waits for working egress, `ok` once an
 * outbound call succeeded, `unverified` when it stopped waiting.
 */
export const EGRESS_READINESS_STATES = ["pending", "ok", "unverified"] as const;

export type EgressReadiness = (typeof EGRESS_READINESS_STATES)[number];

/** Whether an instance in each egress state may take traffic. */
export const EGRESS_READINESS_SERVES_TRAFFIC = {
  pending: false,
  ok: true,
  unverified: true,
} as const satisfies Record<EgressReadiness, boolean>;
