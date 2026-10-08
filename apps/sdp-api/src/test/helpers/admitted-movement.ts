import {
  AdmittedMovement,
  type AdmittedMovementFacts,
  readAdmittedMovement,
} from "@/lib/admit-movement";

type ExpectedFacts = Partial<
  Pick<AdmittedMovementFacts, "organizationId" | "projectId" | "movement" | "kind">
>;

/**
 * Matches an admitted-movement token (HOO-1955) by its facts. The token keeps
 * its facts private, so `expect.objectContaining` cannot see them; this reads
 * them the way a sink does.
 */
export function admittedMovementMatching(expected: ExpectedFacts) {
  return {
    asymmetricMatch(actual: unknown): boolean {
      if (!(actual instanceof AdmittedMovement)) return false;
      const facts = readAdmittedMovement(actual);
      return Object.entries(expected).every(
        ([key, value]) => facts[key as keyof ExpectedFacts] === value
      );
    },
    toString: () => "AdmittedMovement",
    toAsymmetricMatcher: () => `AdmittedMovement matching ${JSON.stringify(expected)}`,
  };
}
