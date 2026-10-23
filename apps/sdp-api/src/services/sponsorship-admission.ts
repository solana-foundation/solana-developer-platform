import type { MovementId } from "@sdp/types/movements";
import {
  assertMovementAdmitted,
  decideMovement,
  type MoneyAdmissionFacts,
  type MoneyAdmissionSubject,
  movementNeedsAdmissionFacts,
  readMoneyAdmissionFacts,
} from "@/lib/money-admission";
import type { Env } from "@/types/env";

/** What sponsorship admission needs to know about a scope. */
export interface SponsorshipAdmissionScope {
  organizationId: string;
  projectId: string;
  actor: { type: string; id: string };
  movement: MovementId;
  /**
   * The custody wallet whose transaction the sponsor pays for, so a key's
   * wallet scope decides the sponsor signature as it does the custody one
   * (SOLA9-834); null when the transaction has none (`/pay`).
   */
  custodyWalletId: string | null;
}

function sponsorSubject(scope: SponsorshipAdmissionScope): MoneyAdmissionSubject {
  return { custodyWalletId: scope.custodyWalletId };
}

/**
 * The organization's and the ambient principal's live state for a sponsor
 * signature (HOO-1955, HOO-2099).
 */
export async function readSponsorshipAdmissionFacts(
  env: Env,
  scope: SponsorshipAdmissionScope
): Promise<MoneyAdmissionFacts | null> {
  // An exit with no principal reads nothing.
  if (!movementNeedsAdmissionFacts(scope.movement)) {
    return null;
  }
  return readMoneyAdmissionFacts(
    env,
    { organizationId: scope.organizationId, projectId: scope.projectId },
    sponsorSubject(scope)
  );
}

/** Throws for a start the organization may not make, or an exit its credential may not. */
export function assertSponsorshipAdmitted(
  scope: SponsorshipAdmissionScope,
  facts: MoneyAdmissionFacts | null
): void {
  assertMovementAdmitted(decideMovement(scope.movement, facts, sponsorSubject(scope)), {
    surface: "sponsor",
    movement: scope.movement,
    organizationId: scope.organizationId,
    projectId: scope.projectId,
    subjectId: `${scope.actor.type}:${scope.actor.id}`,
  });
}
