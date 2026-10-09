/**
 * Money movements (HOO-1955): every reason SDP asks a custody wallet to sign
 * or sponsors a transaction's fees, and whether it starts new exposure or
 * takes money already committed back out. The custody signer and the fee
 * sponsor are each handed the movement they serve and decide when asked to
 * sign, against the organization's live state, whether to.
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

import type { HeliusRingsOperationType } from "./helius-rings";
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
  /** `/pay`: SDP sponsors the payer's transaction for the organization's request. */
  "payments.pay_request": { module: "payments", kind: "start" },

  "recurring.activate": { module: "recurring_payments", kind: "start" },
  "recurring.update": { module: "recurring_payments", kind: "start" },
  /** Cancels the old subscription after an update created its replacement. */
  "recurring.update_cancel_old": { module: "recurring_payments", kind: "exit" },
  "recurring.collect": { module: "recurring_payments", kind: "start" },
  "recurring.resume": { module: "recurring_payments", kind: "start" },
  "recurring.cancel": { module: "recurring_payments", kind: "exit" },

  /**
   * Mint, deploy, thaw, unpause, metadata and authority changes, control-list
   * additions, and blocklist removals (which give an address access back).
   */
  "issuance.authority": { module: "issuance", kind: "start" },
  /**
   * Compliance controls that only reduce exposure: burn, force-burn, freeze,
   * pause, allowlist removal. An issuer must keep them while refused starts.
   */
  "issuance.control": { module: "issuance", kind: "exit" },
  /**
   * Permanent-delegate force transfer from any holder to a caller-chosen
   * destination: it moves value somewhere new, so it is a start.
   */
  "issuance.seize": { module: "issuance", kind: "start" },

  "dvp.create": { module: "dvp", kind: "start" },
  "dvp.fund": { module: "dvp", kind: "start" },
  /** Settles a trade whose legs are funded; cancel and reclaim stay open as exits. */
  "dvp.settle": { module: "dvp", kind: "start" },
  /** Cancels a trade, refunding each party to its own token account. */
  "dvp.cancel": { module: "dvp", kind: "exit" },
  "dvp.reclaim": { module: "dvp", kind: "exit" },

  "earn.deposit": { module: "earn", kind: "start" },
  "earn.withdraw": { module: "earn", kind: "exit" },
  /** Requests a queued withdrawal; the proceeds go to the owner. */
  "earn.queued_withdraw_request": { module: "earn", kind: "exit" },
  /**
   * Cancels a queued withdrawal, putting the shares back into the position.
   * It undoes an exit, and refusing it traps nothing: the request still matures.
   */
  "earn.queued_withdraw_cancel": { module: "earn", kind: "start" },

  "private_channels.session": { module: "private_channels", kind: "start" },
  "private_channels.deposit": { module: "private_channels", kind: "start" },
  "private_channels.transfer": { module: "private_channels", kind: "start" },
  "private_channels.withdraw": { module: "private_channels", kind: "exit" },

  /** Shield, transfer, timelock and zone creation, ring entry. */
  "helius_rings.operation_start": { module: "helius_rings", kind: "start" },
  /** Withdraw, merge, timelock settlement, ring exit. */
  "helius_rings.operation_exit": { module: "helius_rings", kind: "exit" },
  /**
   * Identity registration and custom-ring bring-up (ring config, authority and
   * lookup table, the auditor-key attestation and authority challenge). They
   * open new authority, so they are starts.
   */
  "helius_rings.bring_up": { module: "helius_rings", kind: "start" },
  /**
   * The other transactions the Rings SDK signs on its own: enabling merges
   * (which merge needs) and re-keying an identity. They move no note value and
   * must stay open for an organization's exits.
   */
  "helius_rings.gateway_transaction": { module: "helius_rings", kind: "exit" },
  /**
   * The owner's signature over Zolana's derivation message, and only that
   * message. Shielded keys are re-derived from it on every use, withdrawals
   * included, so refusing it would trap funds.
   */
  "helius_rings.key_derivation": { module: "helius_rings", kind: "exit" },
} as const satisfies Record<string, MovementDefinition>;

export type MovementId = keyof typeof MOVEMENTS;

/**
 * The movement each Rings operation signs for. A new operation type does not
 * compile until it is classified here (a security-reviewed change).
 */
export const HELIUS_RINGS_OPERATION_MOVEMENTS = {
  shield: "helius_rings.operation_start",
  transfer_registered: "helius_rings.operation_start",
  transfer_anonymous: "helius_rings.operation_start",
  withdraw: "helius_rings.operation_exit",
  merge: "helius_rings.operation_exit",
  timelock_create: "helius_rings.operation_start",
  timelock_settle: "helius_rings.operation_exit",
  zone_create: "helius_rings.operation_start",
  ring_exit: "helius_rings.operation_exit",
  ring_entry: "helius_rings.operation_start",
} as const satisfies Record<HeliusRingsOperationType, MovementId>;
