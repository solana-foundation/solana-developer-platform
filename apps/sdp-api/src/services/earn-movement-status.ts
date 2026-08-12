import type { EarnProgramMovementRecordStatus } from "@sdp/types";
import { EARN_TERMINAL_MOVEMENT_STATUSES } from "@sdp/types";

/**
 * Terminality for a movement-ledger row, shared by both appliers (PRO-1669).
 *
 * Direction-independent on purpose: the terminal set is one declaration in
 * `@sdp/types` (also consumed by the dashboard's outcome polling), and a deposit
 * simply never holds the two withdrawal-only values. Lives in its own module so
 * neither ledger service has to import the other — they are separate state
 * machines and must stay that way.
 */
export function isTerminalEarnMovementStatus(status: EarnProgramMovementRecordStatus): boolean {
  return (EARN_TERMINAL_MOVEMENT_STATUSES as readonly string[]).includes(status);
}
