// The service's routes, as `intents/crates/service/src/lib.rs` lists them. The dev server forwards
// `/api` to the service. Every document comes from the service, which reads it from the registry.

export type Recipe = "static" | "program" | "remote" | "remote transaction" | "shielded";

/// An interface input as the form reads it. `amountMint` is the reference to the mint whose
/// decimals an amount uses, such as `{inputs.mint}`.
export interface Input {
  name: string;
  type: string;
  signer: boolean;
  optional: boolean;
  amountMint: string | null;
}

/// A local wallet's private SOL, from its unspent notes in the privacy ring.
export interface RingBalance {
  name: string;
  address: string;
  lamports: number;
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
interface ListedIndex {
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

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`/api${path}`, init);
  const body = (await response.json()) as T & ErrorBody;

  if (body.error !== undefined) {
    throw new ServiceError(body.error.code, body.error.message, body.error.details);
  }

  return body;
}

function post<T>(path: string, body: unknown, headers: Record<string, string> = {}): Promise<T> {
  return call<T>(path, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
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
  interfaceVersion: (id: string, version: string) =>
    call<Published<InterfaceDefinition>>(`/v1/interfaces/${idPath(id)}/versions/${version}`),
  implementationVersion: (id: string, version: string) =>
    call<Published<ImplementationDefinition>>(
      `/v1/implementations/${idPath(id)}/versions/${version}`
    ),
  wallets: () => call<{ wallets: Wallet[] }>("/v1/wallets").then((body) => body.wallets),
  matches: (interfaceId: string, version: string, body: unknown) =>
    post<{ implementations: Candidate[] }>(
      `/v1/interfaces/${idPath(interfaceId)}/versions/${version}/matches`,
      body
    ).then((answer) => answer.implementations),
  prepare: (request: unknown, tamper: boolean) =>
    post<Plan>("/v1/prepare", request, tamper ? { "x-sdp-tamper": "1" } : {}),
  send: (transaction: NonNullable<Plan["transaction"]>) =>
    post<{ signature: string }>("/v1/send", {
      message: transaction.messageBytes,
      presigned: transaction.presigned,
    }),
  ring: () => call<{ wallets: RingBalance[] }>("/v1/ring").then((body) => body.wallets),
  shield: (address: string, lamports: number) =>
    post<{ lamports: number }>("/v1/ring/shield", { address, lamports }),
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
