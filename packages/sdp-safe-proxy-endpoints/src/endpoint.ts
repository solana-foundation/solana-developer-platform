import type { SafeProxyCaller } from "./callers";

export type PathParameter =
  | { format: "digits" }
  | { format: "uuid" }
  | { format: "token" }
  | { format: "one_of"; values: readonly [string, ...string[]] };

type ParameterNames<Path extends string> = Path extends `${string}{${infer Name}}${infer Rest}`
  ? Name | ParameterNames<Rest>
  : never;

type DeclaredParameters<Path extends string> = [ParameterNames<Path>] extends [never]
  ? Record<string, never>
  : Record<ParameterNames<Path>, PathParameter>;

// The one body field Safe Proxy reads, on endpoints that pick their action in the body.
export interface BodyRule {
  field: string;
  values: readonly [string, ...string[]];
}

type IdempotencyKey<Header extends string> =
  | { in: "header"; name: Header }
  | { in: "body"; field: string }
  // The path names the thing changed, so a repeat asks for the same end state.
  | { in: "path" };

type ProviderDedupe = { lasts: "hours"; hours: number } | { lasts: "permanent" };

interface Idempotency<Header extends string> {
  key: IdempotencyKey<NoInfer<Header>>;
  dedupe: ProviderDedupe;
  read: ReadEndpoint;
}

interface EndpointFields<Parameters, Header extends string> {
  method: "GET" | "POST";
  path: string;
  parameters: Parameters;
  query: readonly string[];
  callers: readonly [SafeProxyCaller, ...SafeProxyCaller[]];
  requestHeaders: readonly Header[];
  // A retired endpoint still matches; only a retired endpoint may be removed.
  status: "active" | "retired";
  body?: BodyRule;
}

type EndpointOf<Parameters, Header extends string> =
  | (EndpointFields<Parameters, Header> & { kind: "read" })
  | (EndpointFields<Parameters, Header> & { kind: "sign"; idempotency?: Idempotency<Header> })
  | (EndpointFields<Parameters, Header> & { kind: "change"; idempotency: Idempotency<Header> });

export type AllowedEndpoint = EndpointOf<Readonly<Record<string, PathParameter>>, string>;

export type ReadEndpoint = Extract<AllowedEndpoint, { kind: "read" }>;

export function endpoint<
  const Path extends string,
  const Header extends string,
  const Kind extends AllowedEndpoint["kind"],
>(
  declaration: EndpointOf<DeclaredParameters<Path>, Header> & {
    path: Path;
    kind: Kind;
  }
): AllowedEndpoint & { kind: Kind } {
  return declaration;
}

export interface ProviderDeclaration {
  hosts: readonly [string, ...string[]];
  authScheme: string;
  endpoints: readonly AllowedEndpoint[];
}
