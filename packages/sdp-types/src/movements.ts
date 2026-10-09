/**
 * Money movements (HOO-1955): every reason SDP asks a custody wallet to sign,
 * and whether it starts new exposure or takes money already committed back
 * out. The custody signer is handed the movement it serves and decides at
 * signing time, against the organization's live state, whether to sign.
 *
 * - `start`: anything that opens new exposure, supply, authority or
 *   delegation, including a signature that moves nothing (a signer check).
 *   Refused for a suspended or deleted organization, and for a production
 *   project whose organization lacks the production entitlement.
 * - `exit`: only returns value or obligations the organization already
 *   committed, or finishes work it already started. Never refused (ADR 0002):
 *   money already in must be able to come out.
 *
 * SECURITY REVIEW GATE: classifying a movement as `exit` exempts it from
 * admission, so adding one or changing a `start` to `exit` needs a named
 * security reviewer. Ids are stable: refusal events carry them.
 */

import type { SdpModule } from "./release-channels";

export type MovementKind = "start" | "exit";

export interface MovementDefinition {
  module: SdpModule;
  kind: MovementKind;
}

export const MOVEMENTS = {
  "custody.signer_check": { module: "custody", kind: "start" },

  "payments.transfer": { module: "payments", kind: "start" },
  "payments.transfer_batch": { module: "payments", kind: "start" },

  "recurring.activate": { module: "recurring_payments", kind: "start" },
  "recurring.update": { module: "recurring_payments", kind: "start" },
  /** Cancels the old subscription after an update created its replacement. */
  "recurring.update_cancel_old": { module: "recurring_payments", kind: "exit" },
  "recurring.collect": { module: "recurring_payments", kind: "start" },
  "recurring.resume": { module: "recurring_payments", kind: "start" },
  "recurring.cancel": { module: "recurring_payments", kind: "exit" },

  "issuance.authority": { module: "issuance", kind: "start" },

  "dvp.fund": { module: "dvp", kind: "start" },
  /** Settles a trade whose legs are funded; reclaim stays open as the exit. */
  "dvp.settle": { module: "dvp", kind: "start" },
  "dvp.reclaim": { module: "dvp", kind: "exit" },

  "earn.deposit": { module: "earn", kind: "start" },
  "earn.withdraw": { module: "earn", kind: "exit" },
  /** Requesting and cancelling a queued withdrawal. */
  "earn.queued_withdraw": { module: "earn", kind: "exit" },

  "private_channels.session": { module: "private_channels", kind: "start" },
  "private_channels.deposit": { module: "private_channels", kind: "start" },
  "private_channels.transfer": { module: "private_channels", kind: "start" },
  "private_channels.withdraw": { module: "private_channels", kind: "exit" },

  /** Shield, transfer, timelock and zone creation, ring entry. */
  "helius_rings.operation_start": { module: "helius_rings", kind: "start" },
  /** Withdraw, merge, timelock settlement, ring exit. */
  "helius_rings.operation_exit": { module: "helius_rings", kind: "exit" },
  /** Transactions the Rings SDK signs on its own, for ring bring-up. */
  "helius_rings.gateway_transaction": { module: "helius_rings", kind: "start" },
  /**
   * Raw message signatures. Shielded keys are re-derived from one on every
   * use, withdrawals included, so refusing it would trap funds.
   */
  "helius_rings.key_derivation": { module: "helius_rings", kind: "exit" },
} as const satisfies Record<string, MovementDefinition>;

export type MovementId = keyof typeof MOVEMENTS;
