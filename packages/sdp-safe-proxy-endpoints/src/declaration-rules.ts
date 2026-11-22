import type { AllowedEndpoint, ProviderDeclaration } from "./endpoint";
import { type PatternSegment, patternSegments, segmentAccepts } from "./path-pattern";

function segmentsOverlap(left: PatternSegment, right: PatternSegment): boolean {
  if (left.is === "literal") return segmentAccepts(right, left.value);
  if (right.is === "literal") return segmentAccepts(left, right.value);
  return true;
}

function samePaths(left: AllowedEndpoint, right: AllowedEndpoint): boolean {
  const leftPattern = patternSegments(left);
  const rightPattern = patternSegments(right);
  return (
    left.method === right.method &&
    leftPattern.length === rightPattern.length &&
    leftPattern.every((segment, index) => segmentsOverlap(segment, rightPattern[index]))
  );
}

function bodiesDisjoint(left: AllowedEndpoint, right: AllowedEndpoint): boolean {
  if (left.body === undefined || right.body === undefined) return false;
  const rightValues: readonly string[] = right.body.values;
  return (
    left.body.field === right.body.field &&
    left.body.values.every((value) => !rightValues.includes(value))
  );
}

// The rules a declaration must keep that its type cannot state.
export function declarationProblems(
  providers: Readonly<Record<string, ProviderDeclaration>>
): string[] {
  const problems: string[] = [];
  for (const [name, provider] of Object.entries(providers)) {
    for (const [index, endpoint] of provider.endpoints.entries()) {
      const label = `${name} ${endpoint.method} ${endpoint.path}`;
      for (const other of provider.endpoints.slice(index + 1)) {
        if (samePaths(endpoint, other) && !bodiesDisjoint(endpoint, other)) {
          problems.push(`${label} and ${other.method} ${other.path} can match the same request`);
        }
      }
      for (const header of endpoint.requestHeaders) {
        if (header !== header.toLowerCase()) {
          problems.push(`${label} names request header ${header} in mixed case`);
        }
      }
      if (
        endpoint.kind !== "read" &&
        endpoint.idempotency !== undefined &&
        !provider.endpoints.includes(endpoint.idempotency.read)
      ) {
        problems.push(`${label} pairs a read that ${name} does not declare`);
      }
    }
  }
  return problems;
}
