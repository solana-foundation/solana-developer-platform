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

export interface Candidate {
  id: string;
  version: string;
  recipe: Recipe;
  approved: boolean;
  fits: boolean | null;
  reason: string | null;
}

export interface PlannedInstruction {
  programAddress: string;
  accounts: { address: string; role: number }[];
  data: string;
}

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
  transactions: {
    instructions: PlannedInstruction[];
    config: Record<string, string>;
    compiled: string;
    signatures: { address: string; role: string; status: string }[];
    presigned: { address: string; signature: string }[];
  }[];
  simulation: { unitsConsumed: string };
  rpcCalls: Record<string, number>;
}

export interface Verified {
  message: string;
  matches: boolean | null;
  intents: {
    verify: number;
    built: { start: number; end: number };
    segment: { start: number; end: number };
  }[];
  unverified: number[];
  /// `simulation` for a provider's transaction, which no `verify_intent` proves.
  checkedBy?: string;
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
  verify: (plan: Plan) => {
    const transaction = plan.transactions[0];

    return post<Verified>("/v1/verify", {
      message: transaction?.compiled,
      expected: plan.message,
      presigned: transaction?.presigned ?? [],
      request: plan.request,
    });
  },
  send: (plan: Plan) =>
    post<{ signature: string }>("/v1/send", {
      message: plan.transactions[0]?.compiled,
      presigned: plan.transactions[0]?.presigned ?? [],
    }),
  /// The Jupiter wrapper's switch that adds an approval to an attacker.
  adapterMode: (malicious: boolean) =>
    fetch("/adapter/mode", { method: "POST", body: JSON.stringify({ malicious }) }).then(
      (response) => response.ok
    ),
};
