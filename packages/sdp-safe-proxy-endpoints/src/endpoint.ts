import type { SafeProxyEndpointStatus } from "@sdp/types/safe-proxy";
import { z } from "zod";
import type { SafeProxyCaller } from "./callers";

const pathParameterSchema = z.discriminatedUnion("format", [
  z.object({ format: z.literal("digits") }),
  z.object({ format: z.literal("token") }),
  z.object({ format: z.literal("one_of"), values: z.tuple([z.string()], z.string()).readonly() }),
]);

export type PathParameter = z.infer<typeof pathParameterSchema>;

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

const providerDedupeSchema = z.discriminatedUnion("lasts", [
  z.object({ lasts: z.literal("hours"), hours: z.number() }),
  z.object({ lasts: z.literal("permanent") }),
]);

type ProviderDedupe = z.infer<typeof providerDedupeSchema>;

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
  status: SafeProxyEndpointStatus;
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
