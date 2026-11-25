import type { SafeProxyCaller } from "./callers";

export type PathParameter =
  | { format: "digits" }
  | { format: "token" }
  | { format: "one_of"; values: readonly [string, ...string[]] };

// The one body field Safe Proxy reads, on endpoints that pick their action in the body.
export interface BodyRule {
  field: string;
  values: readonly [string, ...string[]];
}

export interface AllowedEndpoint {
  method: "GET" | "POST";
  // A `{name}` segment is a parameter and has an entry in `parameters`.
  path: string;
  parameters: Readonly<Record<string, PathParameter>>;
  // The query names a request may carry.
  query: readonly string[];
  callers: readonly [SafeProxyCaller, ...SafeProxyCaller[]];
  // The caller's request headers that are passed on to the provider.
  requestHeaders: readonly string[];
  body?: BodyRule;
}

export interface ProviderDeclaration {
  hosts: readonly [string, ...string[]];
  endpoints: readonly AllowedEndpoint[];
}
