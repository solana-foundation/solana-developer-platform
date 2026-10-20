/**
 * Money movements (HOO-1955): every reason SDP asks a custody wallet to sign,
 * sponsors a transaction's fees or opens a provider ramp, and whether it
 * starts new exposure or takes money already committed back out. The custody
 * signer and the fee sponsor are each handed the movement they serve and
 * decide when asked to sign, against the organization's live state, whether
 * to. A ramp quote signs nothing, so it is decided before the provider call.
 *
 * - `start`: anything that opens new exposure, supply, authority or
 *   delegation, including a signature that moves nothing (a signer check).
 *   Refused for a suspended or deleted organization, and for a production
 *   project whose organization lacks the production entitlement.
 * - `exit`: only returns value or obligations the organization already
 *   committed, or finishes work it already started. Never refused for the
 *   organization (ADR 0002): money already in must be able to come out. The
 *   credential asking still must be live and may sign only with wallets in its
 *   scope (ADR 0007 addendum); with no credential (a reconciler) it signs.
 *
 * SECURITY REVIEW GATE: classifying a movement as `exit` exempts it from the
 * organization's admission and from action checks, so adding one or changing
 * a `start` to `exit` needs a named security reviewer. Ids are stable:
 * refusal events carry them.
 */

import type { Action } from "./actions";
import type { HeliusRingsOperationType } from "./helius-rings";
import type { PaymentRecurringPaymentStatus, PaymentRequestStatus } from "./payments";
import type { SdpModule } from "./release-channels";

export type MovementKind = "start" | "exit";

/**
 * A start names the actions that may sign it (HOO-2099): the signing waist
 * refuses a principal that holds none of them. Most starts have one; a
 * movement several routes sign (each declaring its own action) lists each of
 * them, so the waist never refuses what the route admitted. An exit names
 * none: the route's own action admits it.
 */
export type MovementDefinition =
  | { module: SdpModule; kind: "start"; actions: readonly [Action, ...Action[]] }
  | { module: SdpModule; kind: "exit" };

export const MOVEMENTS = {
  "custody.signer_check": { module: "custody", kind: "start", actions: ["wallets.execute"] },

  "payments.transfer": { module: "payments", kind: "start", actions: ["transfers.execute"] },
  "payments.transfer_batch": {
    module: "payments",
    kind: "start",
    actions: ["transfer_batches.execute"],
  },
  /** `/pay`: SDP sponsors the payer's transaction for the organization's request. */
  "payments.pay_request": {
    module: "payments",
    kind: "start",
    actions: ["payment_requests.manage"],
  },

  /** A provider onramp quote or session: the provider takes the buyer's fiat against it. */
  "ramps.onramp_quote": { module: "ramps", kind: "start", actions: ["onramp.execute"] },
  /** A provider offramp quote: the organization starts selling crypto for fiat. */
  "ramps.offramp_quote": { module: "ramps", kind: "start", actions: ["offramp.execute"] },

  "recurring.activate": {
    module: "recurring_payments",
    kind: "start",
    actions: ["recurring.execute"],
  },
  "recurring.update": {
    module: "recurring_payments",
    kind: "start",
    actions: ["recurring.execute"],
  },
  /** Cancels the old subscription after an update created its replacement. */
  "recurring.update_cancel_old": { module: "recurring_payments", kind: "exit" },
  "recurring.collect": {
    module: "recurring_payments",
    kind: "start",
    actions: ["recurring.execute"],
  },
  "recurring.resume": {
    module: "recurring_payments",
    kind: "start",
    actions: ["recurring.execute"],
  },
  "recurring.cancel": { module: "recurring_payments", kind: "exit" },

  /**
   * Mint, deploy, thaw, unpause, metadata and authority changes, and
   * control-list changes that grant access (allowlist additions, blocklist
   * removals).
   */
  "issuance.authority": {
    module: "issuance",
    kind: "start",
    // Metadata edits (manage), mint and deploy (execute), thaw, unpause and
    // allowlist grants (enforce), authority changes (authority).
    actions: ["issuance.manage", "issuance.execute", "issuance.enforce", "issuance.authority"],
  },
  /**
   * Compliance controls that only reduce exposure: burn, force-burn, freeze,
   * pause, and control-list changes that take access away (allowlist
   * removals, blocklist additions). An issuer must keep them while refused
   * starts.
   */
  "issuance.control": { module: "issuance", kind: "exit" },
  /**
   * Permanent-delegate force transfer from any holder to a caller-chosen
   * destination: it moves value somewhere new, so it is a start.
   */
  "issuance.seize": { module: "issuance", kind: "start", actions: ["issuance.enforce"] },

  "dvp.create": { module: "dvp", kind: "start", actions: ["dvp.manage"] },
  "dvp.fund": { module: "dvp", kind: "start", actions: ["dvp.execute"] },
  /** Settles a trade whose legs are funded; cancel and reclaim stay open as exits. */
  "dvp.settle": { module: "dvp", kind: "start", actions: ["dvp.execute"] },
  /** Cancels a trade, refunding each party to its own token account. */
  "dvp.cancel": { module: "dvp", kind: "exit" },
  "dvp.reclaim": { module: "dvp", kind: "exit" },

  "earn.deposit": { module: "earn", kind: "start", actions: ["earn.execute"] },
  "earn.withdraw": { module: "earn", kind: "exit" },
  /** Requests a queued withdrawal; the proceeds go to the owner. */
  "earn.queued_withdraw_request": { module: "earn", kind: "exit" },
  /**
   * Cancels a queued withdrawal, putting the shares back into the position.
   * It undoes an exit, and refusing it traps nothing: the request still matures.
   */
  "earn.queued_withdraw_cancel": { module: "earn", kind: "start", actions: ["earn.manage"] },

  "private_channels.session": {
    module: "private_channels",
    kind: "start",
    actions: ["private_channels.execute"],
  },
  "private_channels.deposit": {
    module: "private_channels",
    kind: "start",
    actions: ["private_channels.execute"],
  },
  "private_channels.transfer": {
    module: "private_channels",
    kind: "start",
    actions: ["private_channels.execute"],
  },
  /**
   * The destination is the caller's choice, by decision: an organization
   * refused starts still owns what it deposited and may send it anywhere, and
   * a compromised organization is suspended, which refuses every request.
   */
  "private_channels.withdraw": { module: "private_channels", kind: "exit" },

  /** Shield, transfer, timelock and zone creation, ring entry. */
  "helius_rings.operation_start": {
    module: "helius_rings",
    kind: "start",
    actions: ["helius_rings.execute"],
  },
  /**
   * Withdraw, merge, timelock settlement, ring exit. A withdrawal may pay any
   * address, for the same reason as `private_channels.withdraw`.
   */
  "helius_rings.operation_exit": { module: "helius_rings", kind: "exit" },
  /**
   * Identity registration and custom-ring bring-up (ring config, authority and
   * lookup table, the auditor-key attestation and authority challenge). They
   * open new authority, so they are starts. Also the default for any other
   * transaction the Rings SDK signs, so a new SDK flow is refused until
   * classified.
   */
  "helius_rings.bring_up": {
    module: "helius_rings",
    kind: "start",
    // Wallet and ring creation (manage); an unclassified SDK flow on an
    // operation route (execute).
    actions: ["helius_rings.manage", "helius_rings.execute"],
  },
  /**
   * The two SDK flows named as exits: enabling merges (which merge needs) and
   * re-keying an identity. Re-keying replaces the identity's keys, but over
   * notes the owner already holds and to the same owner, so it is exit
   * support; it moves no note value. Security-reviewed as such.
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

/** The movements that start new exposure, each with the actions that may sign it. */
export type StartMovementId = {
  [Id in MovementId]: (typeof MOVEMENTS)[Id]["kind"] extends "start" ? Id : never;
}[MovementId];

/**
 * The actions that may sign a start (HOO-2099): the principal must hold one.
 * Null for an exit, which no principal check refuses.
 */
export function movementActions(movement: MovementId): readonly Action[] | null {
  const definition: MovementDefinition = MOVEMENTS[movement];
  return definition.kind === "start" ? definition.actions : null;
}

/**
 * A recurring payment is a mandate (APE-343): the scheduler signs for it as
 * the mandate, not as whoever created or activated it. Each movement it may
 * sign, and the recurring-payment statuses that admit it: a scheduled
 * collection needs an `active` mandate; the job's recovery of an activation or
 * a resume needs the row still in that operation. Anything else, `canceled`
 * above all, refuses. A key's revocation does not stop its mandates.
 */
export const MANDATE_MOVEMENT_STATUSES = {
  "recurring.collect": ["active"],
  "recurring.activate": ["activating"],
  "recurring.resume": ["resuming"],
} as const satisfies Partial<Record<StartMovementId, readonly PaymentRecurringPaymentStatus[]>>;

/**
 * A `/pay` link signs only its own sponsored payment, and only while the
 * payment request is still open.
 */
export const PAYMENT_REQUEST_MOVEMENT_STATUSES = {
  "payments.pay_request": ["awaiting_payment"],
} as const satisfies Partial<Record<StartMovementId, readonly PaymentRequestStatus[]>>;

/** The movements one module signs for. */
export type MovementOf<Module extends SdpModule> = {
  [Id in MovementId]: (typeof MOVEMENTS)[Id]["module"] extends Module ? Id : never;
}[MovementId];

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
