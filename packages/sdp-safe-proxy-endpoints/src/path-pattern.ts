import type { AllowedEndpoint, PathParameter } from "./endpoint";

export type PatternSegment =
  | { is: "literal"; value: string }
  | { is: "parameter"; parameter: PathParameter };

// Every path segment Safe Proxy forwards is made of these characters only.
const SEGMENT = /^[A-Za-z0-9_-]+$/;
const DIGITS = /^[0-9]{1,100}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const TOKEN = /^[A-Za-z0-9_-]{1,255}$/;

export function pathSegments(path: string): string[] | null {
  if (!path.startsWith("/")) return null;
  const segments = path.slice(1).split("/");
  return segments.every((segment) => SEGMENT.test(segment)) ? segments : null;
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
  switch (parameter.format) {
    case "digits":
      return DIGITS.test(segment);
    case "uuid":
      return UUID.test(segment);
    case "token":
      return TOKEN.test(segment);
    case "one_of":
      return parameter.values.includes(segment);
    default: {
      const unhandled: never = parameter;
      throw new Error(`unhandled path parameter: ${JSON.stringify(unhandled)}`);
    }
  }
}

export function segmentAccepts(pattern: PatternSegment, segment: string): boolean {
  return pattern.is === "literal"
    ? pattern.value === segment
    : parameterAccepts(pattern.parameter, segment);
}
