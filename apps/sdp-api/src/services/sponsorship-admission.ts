import { MOVEMENTS, type MovementId } from "@sdp/types";
import {
  assertMovementAdmitted,
  decideMovement,
  type MoneyAdmissionFacts,
  readMoneyAdmissionFacts,
} from "@/lib/money-admission";
import type { Env } from "@/types/env";

/** What sponsorship admission needs to know about a scope. */
export interface SponsorshipAdmissionScope {
  organizationId: string;
  projectId: string | null;
  actor: { type: string; id: string };
  movement: MovementId;
}

/**
 * The organization's live state for a sponsor signature (HOO-1955). A scope
 * with no project has nothing to read, and so cannot start money.
 */
export async function readSponsorshipAdmissionFacts(
  env: Env,
  scope: SponsorshipAdmissionScope,
  readFacts: typeof readMoneyAdmissionFacts = readMoneyAdmissionFacts
): Promise<MoneyAdmissionFacts | null> {
  // An exit always passes, so it reads nothing.
  if (MOVEMENTS[scope.movement].kind === "exit" || scope.projectId === null) {
    return null;
  }
  return readFacts(env, { organizationId: scope.organizationId, projectId: scope.projectId });
}

/** Throws for a start the organization may not make; an exit always passes. */
export function assertSponsorshipAdmitted(
  scope: SponsorshipAdmissionScope,
  facts: MoneyAdmissionFacts | null
): void {
  assertMovementAdmitted(decideMovement(scope.movement, facts), {
    surface: "sponsor",
    movement: scope.movement,
    organizationId: scope.organizationId,
    projectId: scope.projectId,
    subjectId: `${scope.actor.type}:${scope.actor.id}`,
  });
}
