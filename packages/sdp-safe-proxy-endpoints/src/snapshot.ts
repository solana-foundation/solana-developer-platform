import type { AllowedEndpoint, PathParameter } from "./endpoint";
import { FORMAT_PATTERNS } from "./path-pattern";
import { SAFE_PROXY_PROVIDERS } from "./providers";

function parameterText(parameter: PathParameter): string {
  return parameter.format === "one_of"
    ? `one_of ${parameter.values.join(" ")}`
    : `${parameter.format} ${FORMAT_PATTERNS[parameter.format].source}`;
}

function idempotencyRow(endpoint: AllowedEndpoint) {
  if (endpoint.kind === "read" || endpoint.idempotency === undefined) return undefined;
  const { key, dedupe, read } = endpoint.idempotency;
  return {
    key: Object.values(key).join(" "),
    dedupe: Object.values(dedupe).join(" "),
    read: `${read.method} ${read.path}`,
  };
}

function endpointRow(endpoint: AllowedEndpoint) {
  return {
    kind: endpoint.kind,
    status: endpoint.status,
    callers: [...endpoint.callers].sort().join(" "),
    query: [...endpoint.query].sort().join(" "),
    requestHeaders: [...endpoint.requestHeaders].sort().join(" "),
    parameters: Object.fromEntries(
      Object.entries(endpoint.parameters).map(([name, parameter]) => [
        name,
        parameterText(parameter),
      ])
    ),
    idempotency: idempotencyRow(endpoint),
  };
}

// One row per endpoint, and one per allowed value where a body rule picks the action.
function endpointRows(endpoint: AllowedEndpoint) {
  const target = `${endpoint.method} ${endpoint.path}`;
  const row = endpointRow(endpoint);
  if (endpoint.body === undefined) return [[target, row] as const];
  const { field, values } = endpoint.body;
  return values.map((value) => [`${target} ${field}=${value}`, row] as const);
}

export function renderEndpointSnapshot(): string {
  const snapshot = Object.fromEntries(
    Object.entries(SAFE_PROXY_PROVIDERS).map(([name, provider]) => [
      name,
      {
        hosts: provider.hosts.join(" "),
        authScheme: provider.authScheme,
        endpoints: Object.fromEntries(
          provider.endpoints
            .flatMap(endpointRows)
            .sort(([left], [right]) => left.localeCompare(right))
        ),
      },
    ])
  );
  return `${JSON.stringify(snapshot, null, 2)}\n`;
}
