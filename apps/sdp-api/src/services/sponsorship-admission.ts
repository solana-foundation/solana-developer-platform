import { MOVEMENTS, type MovementId } from "@sdp/types";
import {
  assertMovementAdmitted,
  decideMovement,
  type MoneyAdmissionFacts,
  readMoneyAdmissionFacts,
} from "@/lib/money-admission";
import type { Env } from "@/types/env";

/**
 * A sponsor signs fees, never with a custody wallet, so no wallet scope
 * applies to it; the custody signature in the same transaction, if any, is
 * scoped by the custody signer.
 */
const SPONSOR_SUBJECT = { custodyWalletId: null } as const;

/** What sponsorship admission needs to know about a scope. */
export interface SponsorshipAdmissionScope {
  organizationId: string;
  projectId: string;
  actor: { type: string; id: string };
  movement: MovementId;
}

/**
 * The organization's and the ambient principal's live state for a sponsor
 * signature (HOO-1955, HOO-2099). A scope with no project has nothing to read,
 * and so cannot start money.
 */
export async function readSponsorshipAdmissionFacts(
  env: Env,
  scope: SponsorshipAdmissionScope
): Promise<MoneyAdmissionFacts | null> {
  // An exit always passes, so it reads nothing.
  if (MOVEMENTS[scope.movement].kind === "exit") {
    return null;
  }
  return readMoneyAdmissionFacts(
    env,
    { organizationId: scope.organizationId, projectId: scope.projectId },
    SPONSOR_SUBJECT
  );
}

/** Throws for a start the organization may not make; an exit always passes. */
export function assertSponsorshipAdmitted(
  scope: SponsorshipAdmissionScope,
  facts: MoneyAdmissionFacts | null
): void {
  assertMovementAdmitted(decideMovement(scope.movement, facts, SPONSOR_SUBJECT), {
    surface: "sponsor",
    movement: scope.movement,
    organizationId: scope.organizationId,
    projectId: scope.projectId,
    subjectId: `${scope.actor.type}:${scope.actor.id}`,
  });
}
