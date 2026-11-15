// The service's routes, as `intents/crates/service/src/lib.rs` lists them. The dev server forwards
// `/api` to the service. Every document comes from the service, which reads it from the registry.

/// Where a build proves its spend. The service's prover sees the spend; it cannot sign it.
export type Prover = "wallet" | "service";

export type Recipe = "static" | "program" | "remote" | "remote transaction" | "shielded" | "flow";

/// An interface input as the form reads it. `amountMint` is the reference to the mint whose
/// decimals an amount uses, such as `{inputs.mint}`.
export interface Input {
  name: string;
  type: string;
  signer: boolean;
  optional: boolean;
  amountMint: string | null;
}

/// A local wallet's private balances, from its unspent notes in the privacy ring: SOL in lamports,
/// and each SPL asset's base units by mint.
export interface RingBalance {
  name: string;
  address: string;
  lamports: number;
  tokens: Record<string, string>;
}

/// What the form needs of an interface, from its definition.
export interface InterfaceDocument {
  settlement: "atomic" | "async";
  display: string;
  inputs: Input[];
  outputs: { name: string; type: string }[];
  postConditions: string[];
}

/// An interface as `intents/definitions` writes it. The service decompiles it from the registry.
export interface InterfaceDefinition {
  id: string;
  version: string;
  settlement?: "async";
  inputs: {
    name: string;
    type: string;
    signer?: boolean;
    optional?: boolean;
    display?: { amount?: { mint: string } };
  }[];
  outputs: { name: string; type: string }[];
  display: string;
  postConditions: { message: string }[];
}

/// An implementation as `intents/definitions` writes it, with the fields that the playground reads.
export interface ImplementationDefinition {
  id: string;
  version: string;
  cluster: string;
  recipe: { kind: "static" | "program" | "remote"; returns?: "instructions" | "transaction" };
  /// What the implementation promises beyond the interface's guarantees.
  postConditions?: { message: string }[];
}

export interface VersionEntry {
  version: string;
  publishSlot: string;
  approved: boolean;
  removed: boolean;
  tier: number;
}

/// An index as the service lists it. `shown` is the version that the playground shows: the head,
/// or the newest version that is not removed.
export interface ListedIndex {
  id: string;
  organization: string;
  name: string;
  address: string;
  head: string | null;
  updateAuthority: string;
  versions: VersionEntry[];
  shown: string | null;
}

export interface ListedInterface extends ListedIndex {
  approveNewVersions: boolean;
  approveAuthority: string;
}

export interface ListedImplementation extends ListedIndex {
  /// The id of the interface that it implements.
  interface: string | null;
  approved: boolean;
}

export interface Registry {
  organizations: { name: string; address: string; authority: string }[];
  interfaces: ListedInterface[];
  implementations: ListedImplementation[];
  circuits: ListedIndex[];
}

/// What a shielded recipe proves with: its proving keys and prover module by SHA-256, and where to
/// fetch them (`DESIGN.md`, 4.17).
export interface CircuitDefinition {
  id: string;
  version: string;
  protocol: string;
  proofSystem: string;
  provingKeys: string;
  module?: string;
  sources: string[];
}

/// One published version, with its document decompiled from the registry's bytes.
export interface Published<Definition> extends VersionEntry {
  id: string;
  address: string;
  document: Definition;
  bytes: string;
}

export interface Wallet {
  name: string;
  address: string;
}

/// Whether an implementation applies to the inputs: its `applies` checks hold, one fails, or the inputs do
/// not compile.
export type CandidateStatus = "applies" | "doesNotApply" | "invalidInputs" | "unknown";

export interface Candidate {
  id: string;
  version: string;
  recipe: Recipe;
  approved: boolean;
  status: CandidateStatus;
  reason: string | null;
}

export interface PlannedInstruction {
  programAddress: string;
  accounts: { address: string; role: number }[];
  data: string;
}

/// `instructions` and `computeBudget` are absent for a provider's signed transaction. `transaction`
/// is absent when the request asks for the instructions alone.
export interface Plan {
  message: string;
  intents: {
    display: string;
    builder: { program: string } | null;
    verify: number | null;
    span: { start: number; end: number };
    builderSimulations: number;
  }[];
  request: unknown;
  signers: { address: string; role: string }[];
  priorityFeeLamports: string;
  instructions?: PlannedInstruction[];
  computeBudget?: Record<string, string>;
  transaction?: {
    version: "legacy" | 0 | 1;
    messageBytes: string;
    lastValidBlockHeight: string | null;
    presigned: { address: string; signature: string }[];
  };
  /// `unitsByInstruction` is `null` for a builtin program, which logs no units.
  simulation: { unitsConsumed: string; unitsByInstruction: (string | null)[] };
  rpcCalls: Record<string, number>;
}

/// One step of a `sign`: a plan, named, with what its signer signs.
export interface SignStep extends Omit<Plan, "request" | "rpcCalls"> {
  name: string;
  signs: "transaction" | "digest" | "message";
}

/// What the caller does next (`DESIGN.md`, 4.1).
export type Next =
  | { kind: "sign"; land: "inOrder" | "bundle"; steps: SignStep[] }
  | { kind: "build"; step: string; spend: Record<string, unknown> }
  | {
      kind: "wait";
      step: string;
      until: Record<string, unknown>;
      message: string;
      checkAfter: string;
    }
  | { kind: "done"; message: string };

/// Every call of the loop answers the same shape. The caller keeps `progress` and sends it back
/// unchanged.
export interface Answer {
  progress: Record<string, unknown>;
  next: Next;
  pendingUntil: { blockHeight: string } | null;
  rpcCalls: Record<string, number>;
}

/// The body of `POST /v1/intents/continue`.
export interface ContinueBody {
  progress: Record<string, unknown>;
  signatures?: string[];
  /// The spend that the caller's wallet built for the last `build`.
  built?: Record<string, unknown>;
}

export class ServiceError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly details: unknown
  ) {
    super(message);
  }
}

interface ErrorBody {
  error?: { code: string; message: string; details: unknown };
}

/// `base` is `/api` for the intents service, or `/wallet` for the local wallet, which holds the keys.
async function call<T>(path: string, init?: RequestInit, base = "/api"): Promise<T> {
  const response = await fetch(`${base}${path}`, init);
  const body = (await response.json()) as T & ErrorBody;

  if (body.error !== undefined) {
    throw new ServiceError(body.error.code, body.error.message, body.error.details);
  }

  return body;
}

function post<T>(
  path: string,
  body: unknown,
  headers: Record<string, string> = {},
  base = "/api"
): Promise<T> {
  return call<T>(
    path,
    {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    },
    base
  );
}

function shown(index: Omit<ListedIndex, "shown">): string | null {
  return index.head ?? index.versions.filter((entry) => !entry.removed).at(-1)?.version ?? null;
}

/// `solana.org/token.transfer` as the path `solana.org/token.transfer`, with each part encoded.
function idPath(id: string): string {
  return id.split("/").map(encodeURIComponent).join("/");
}

export const api = {
  registry: () =>
    call<Registry>("/v1/registry").then((registry) => ({
      ...registry,
      interfaces: registry.interfaces.map((listed) => ({ ...listed, shown: shown(listed) })),
      implementations: registry.implementations.map((listed) => ({
        ...listed,
        shown: shown(listed),
      })),
    })),
  circuitVersion: (id: string, version: string) =>
    call<Published<CircuitDefinition>>(`/v1/circuits/${idPath(id)}/versions/${version}`),
  interfaceVersion: (id: string, version: string) =>
    call<Published<InterfaceDefinition>>(`/v1/interfaces/${idPath(id)}/versions/${version}`),
  implementationVersion: (id: string, version: string) =>
    call<Published<ImplementationDefinition>>(
      `/v1/implementations/${idPath(id)}/versions/${version}`
    ),
  wallets: () =>
    call<{ wallets: Wallet[] }>("/wallets", undefined, "/wallet").then((body) => body.wallets),
  matches: (interfaceId: string, version: string, body: unknown) =>
    post<{ implementations: Candidate[] }>(
      `/v1/interfaces/${idPath(interfaceId)}/versions/${version}/matches`,
      body
    ).then((answer) => answer.implementations),
  start: (request: unknown, tamper: boolean) =>
    post<Answer>("/v1/intents/start", request, tamper ? { "x-sdp-tamper": "1" } : {}),
  resume: (body: ContinueBody) => post<Answer>("/v1/intents/continue", body),
  /// The wallet builds the spend that a `build` names, and proves it with its own prover or the
  /// service's. Only the caller talks to its wallet.
  build: (spend: Record<string, unknown>, prover: Prover) =>
    post<Record<string, unknown>>("/shielded/build", { spend, prover }, {}, "/wallet"),
  send: (transaction: NonNullable<Plan["transaction"]>) =>
    post<{ signature: string }>(
      "/send",
      { message: transaction.messageBytes, presigned: transaction.presigned },
      {},
      "/wallet"
    ),
  ring: () =>
    call<{ wallets: RingBalance[] }>("/ring", undefined, "/wallet").then((body) => body.wallets),
  shield: (address: string, lamports: number) =>
    post<{ lamports: number }>("/ring/shield", { address, lamports }, {}, "/wallet"),
  /// The Jupiter wrapper's switch that adds an approval to an attacker.
  adapterMode: (malicious: boolean) =>
    fetch("/adapter/mode", { method: "POST", body: JSON.stringify({ malicious }) }).then(
      (response) => response.ok
    ),
};

/// The form's view of an interface definition.
export function interfaceForm(definition: InterfaceDefinition): InterfaceDocument {
  return {
    settlement: definition.settlement ?? "atomic",
    display: definition.display,
    inputs: definition.inputs.map((input) => ({
      name: input.name,
      type: input.type,
      signer: input.signer ?? false,
      optional: input.optional ?? false,
      amountMint: input.display?.amount?.mint ?? null,
    })),
    outputs: definition.outputs,
    postConditions: definition.postConditions.map((condition) => condition.message),
  };
}

export function recipeOf(definition: ImplementationDefinition): Recipe {
  return definition.recipe.kind === "remote" && definition.recipe.returns === "transaction"
    ? "remote transaction"
    : definition.recipe.kind;
}
