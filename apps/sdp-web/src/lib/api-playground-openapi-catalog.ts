import type { ApiPlaygroundEndpointConfig } from "@/components/api-playground-shell";
import generatedCatalog from "./api-playground-catalog.generated.json";

type PlaygroundModule = "wallets" | "payments" | "counterparties" | "issuance";

interface GeneratedPlaygroundCatalog {
  modules: Record<PlaygroundModule, ApiPlaygroundEndpointConfig[]>;
}

const catalog = generatedCatalog as GeneratedPlaygroundCatalog;

function operationKey(endpoint: ApiPlaygroundEndpointConfig): string {
  return `${endpoint.method} ${endpoint.path.split("?", 1)[0]}`;
}

/**
 * Keeps the hand-authored forms for existing endpoints and fills every missing
 * operation from the public OpenAPI module catalog.
 */
export function mergeOpenApiPlaygroundEndpoints(
  module: PlaygroundModule,
  curatedEndpoints: ApiPlaygroundEndpointConfig[]
): ApiPlaygroundEndpointConfig[] {
  const curatedKeys = new Set(curatedEndpoints.map(operationKey));
  const missingEndpoints = catalog.modules[module].filter(
    (endpoint) => !curatedKeys.has(operationKey(endpoint))
  );

  return [...curatedEndpoints, ...missingEndpoints];
}

export function getOpenApiPlaygroundEndpoints(
  module: PlaygroundModule
): ApiPlaygroundEndpointConfig[] {
  return catalog.modules[module];
}
