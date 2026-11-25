import { z } from "zod";
import type { AllowedEndpoint, PathParameter } from "./endpoint";

export type PatternSegment =
  | { is: "literal"; value: string }
  | { is: "parameter"; parameter: PathParameter };

// Every path segment Safe Proxy forwards is made of these characters only.
const segmentsSchema = z.array(z.string().regex(/^[A-Za-z0-9_-]+$/));

export const FORMAT_PATTERNS = {
  digits: /^[0-9]{1,100}$/,
  token: /^[A-Za-z0-9_-]{1,255}$/,
} as const satisfies Record<Exclude<PathParameter["format"], "one_of">, RegExp>;

export function pathSegments(path: string): string[] | null {
  if (!path.startsWith("/")) return null;
  const segments = segmentsSchema.safeParse(path.slice(1).split("/"));
  return segments.success ? segments.data : null;
}

export function patternSegments(endpoint: AllowedEndpoint): PatternSegment[] {
  return endpoint.path
    .slice(1)
    .split("/")
    .map((segment) => {
      const name = /^\{(.+)\}$/.exec(segment)?.[1];
      return name === undefined
        ? { is: "literal", value: segment }
        : { is: "parameter", parameter: endpoint.parameters[name] };
    });
}

export function parameterAccepts(parameter: PathParameter, segment: string): boolean {
  return parameter.format === "one_of"
    ? parameter.values.includes(segment)
    : FORMAT_PATTERNS[parameter.format].test(segment);
}

export function segmentAccepts(pattern: PatternSegment, segment: string): boolean {
  return pattern.is === "literal"
    ? pattern.value === segment
    : parameterAccepts(pattern.parameter, segment);
}
