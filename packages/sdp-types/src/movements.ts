/**
 * Money movements (HOO-1955): every reason SDP may acquire a custody signer or
 * a sponsored fee payer, and whether it starts new exposure or takes money
 * already committed back out.
 *
 * - `start`: anything that opens new exposure, supply, authority or
 *   delegation, including a signature that moves nothing (a signer check).
 *   Refused for a suspended or deleted organization, and for a production
 *   project whose organization lacks the production entitlement.
 * - `exit`: only returns value or obligations the organization already
 *   committed. Never refused (ADR 0002): money already in must be able to
 *   come out. Adding an exit is a security-reviewed change.
 *
 * Ids are stable: refusal events carry them, so they are never renamed.
 */

import type { OperationType } from "./allowed-operations";
import type { SDP_MODULE_STAGES, SdpModule } from "./release-channels";

export type MovementKind = "start" | "exit";

export interface MovementDefinition {
  module: SdpModule;
  kind: MovementKind;
  /**
   * The Allowed Operation (ADR 0006) an API key must hold to perform this
   * movement, or null when customers have no operation to grant for it.
   */
  allowedOperation: OperationType | null;
}

export const MOVEMENTS = {
  "custody.signer_check": { module: "custody", kind: "start", allowedOperation: null },
  "payments.transfer": {
    module: "payments",
    kind: "start",
    allowedOperation: "payment_transfer_execute",
  },
  "payments.transfer_batch": {
    module: "payments",
    kind: "start",
    allowedOperation: "payment_transfer_batch_execute",
  },
  "payments.pay_request": { module: "payments", kind: "start", allowedOperation: null },
  "recurring.activate": { module: "recurring_payments", kind: "start", allowedOperation: null },
  "recurring.update": {
    module: "recurring_payments",
    kind: "start",
    allowedOperation: "recurring_payment_update",
  },
  "recurring.collect": {
    module: "recurring_payments",
    kind: "start",
    allowedOperation: "recurring_payment_collection",
  },
  "recurring.resume": { module: "recurring_payments", kind: "start", allowedOperation: null },
  "recurring.cancel": { module: "recurring_payments", kind: "exit", allowedOperation: null },
} as const satisfies Record<string, MovementDefinition>;

export type MovementId = keyof typeof MOVEMENTS;

export function isMovementId(value: string): value is MovementId {
  return Object.hasOwn(MOVEMENTS, value);
}

type StagedModule = keyof typeof SDP_MODULE_STAGES;
type ModulesAtStage<Stage> = {
  [M in StagedModule]: (typeof SDP_MODULE_STAGES)[M] extends Stage ? M : never;
}[StagedModule];

/**
 * Modules whose signers and sponsorship are not admitted yet: they mint
 * through the escape hatch, which refuses nothing and logs what admission
 * would refuse. A `stable` module cannot be listed, so promoting one breaks
 * the build until its admission lands. Each module's slice removes its entry.
 */
export const LEGACY_MOVEMENT_MODULES = [
  "dvp",
  "earn",
  "helius_rings",
  "issuance",
  "policies",
  "private_channels",
] as const satisfies readonly Exclude<StagedModule, ModulesAtStage<"stable">>[];

export type LegacyMovementModule = (typeof LEGACY_MOVEMENT_MODULES)[number];
