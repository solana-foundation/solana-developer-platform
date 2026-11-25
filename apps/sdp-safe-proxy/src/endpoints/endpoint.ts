import type { SafeProxyCaller } from "./callers";

export type PathParameter =
  | { format: "digits" }
  | { format: "token" }
  | { format: "one_of"; values: readonly [string, ...string[]] };

export interface BodyRule {
  field: string;
  values: readonly [string, ...string[]];
}

export interface AllowedEndpoint {
  method: "GET" | "POST";
  path: string;
  parameters: Readonly<Record<string, PathParameter>>;
  query: readonly string[];
  callers: readonly [SafeProxyCaller, ...SafeProxyCaller[]];
  requestHeaders: readonly string[];
  body?: BodyRule;
}

export interface ProviderDeclaration {
  hosts: readonly [string, ...string[]];
  endpoints: readonly AllowedEndpoint[];
}
