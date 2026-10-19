/**
 * Outcomes of one slot of a Cron Definition, as logged on every `sdp_cron_run`
 * event (ADR 0011). Liveness alerts in sdp-infra match these values.
 *
 * - `ok`: the work ran to completion for this slot without throwing.
 * - `error`: the work started and threw. RPC attempts cut off by SDP's own
 *   deadline, failed genesis probes and database statement timeouts all land
 *   here, told apart by `error_name` / `error_code`; a timeout is never its
 *   own status. So does a run still in flight at the runner's slot deadline
 *   (`CRON_SLOT_DEADLINE_EXCEEDED`): its registration is freed and the work is
 *   abandoned, not cancelled, so its own outcome may still be logged later.
 *   The next slot runs normally.
 * - `skipped_overlap`: the slot fired while the same registration's previous
 *   run was still in flight, so no work started for this slot.
 * - `disabled`: the definition's `enabled` decision was false when the worker
 *   registered it; the slot fired and no work ran.
 */
export const CRON_RUN_STATUSES = ["ok", "error", "skipped_overlap", "disabled"] as const;

export type CronRunStatus = (typeof CRON_RUN_STATUSES)[number];
