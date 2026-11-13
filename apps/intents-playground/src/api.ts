// The service's routes, as `intents/crates/service/src/lib.rs` lists them. The dev server forwards
// `/api` to the service.

export type Recipe = "static" | "program" | "remote" | "remote transaction";

export interface Input {
  name: string;
  type: string;
  signer: boolean;
  optional: boolean;
  amountMint: string | null;
}

export interface InterfaceDocument {
  settlement: "atomic" | "async";
  display: string;
  inputs: Input[];
  outputs: { name: string; type: string }[];
  postConditions: string[];
}

export interface ImplementationDocument {
  recipe: Recipe;
  /// The cluster's name, such as `mainnet`, or its genesis hash when it has none.
  cluster: string;
  message: string;
  applies: string[];
  url: string | null;
}

export interface VersionEntry {
  version: string;
  publishSlot: string;
  approved: boolean;
  removed: boolean;
  tier: number;
}

interface ListedIndex {
  id: string | null;
  address: string;
  organization: string;
  head: string | null;
  updateAuthority: string;
  versions: VersionEntry[];
  shown: string | null;
  bytes: string | null;
}

export interface ListedInterface extends ListedIndex {
  approveNewVersions: boolean;
  approveAuthority: string;
  approved: string[];
  document: InterfaceDocument | null;
}

export interface ListedImplementation extends ListedIndex {
  interface: string;
  approved: boolean;
  document: ImplementationDocument | null;
}

export interface Registry {
  organizations: { name: string; address: string; authority: string }[];
  interfaces: ListedInterface[];
  implementations: ListedImplementation[];
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

export const api = {
  registry: () => call<Registry>("/v1/registry"),
  wallets: () => call<{ wallets: Wallet[] }>("/v1/wallets").then((body) => body.wallets),
  implementations: (body: unknown) =>
    post<{ implementations: Candidate[] }>("/v1/implementations", body).then(
      (answer) => answer.implementations
    ),
  prepare: (request: unknown, tamper: boolean) =>
    post<Plan>("/v1/prepare", request, tamper ? { "x-sdp-tamper": "1" } : {}),
  send: (transaction: NonNullable<Plan["transaction"]>) =>
    post<{ signature: string }>("/v1/send", {
      message: transaction.messageBytes,
      presigned: transaction.presigned,
    }),
  /// The definition as it is in `intents/definitions`, which the dev server serves.
  definition: (kind: "interfaces" | "implementations", id: string, version: string) => {
    const [organization, name] = id.split("/");

    return fetch(`/definitions/${organization}/${kind}/${name}/${version}.json`).then((response) =>
      response.ok ? response.text() : null
    );
  },
  /// The Jupiter wrapper's switch that adds an approval to an attacker.
  adapterMode: (malicious: boolean) =>
    fetch("/adapter/mode", { method: "POST", body: JSON.stringify({ malicious }) }).then(
      (response) => response.ok
    ),
};
