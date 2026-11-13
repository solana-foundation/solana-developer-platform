// Verifies an SDP transaction for its signer, before it signs. It runs the Rust verifier of
// `intents/crates/verifier-wasm` as WebAssembly, so TypeScript and Rust verify a message the same
// way. It reads the registry and the accounts from the signer's RPC, not from the service that
// planned the transaction.

export interface Range {
  start: number;
  end: number;
}

/// Where one intent's segment is in the transaction.
export interface VerifiedIntent {
  verify: number;
  /// The instructions that the record built.
  built: Range;
  /// `verify_intent` and every instruction after it that the segment holds.
  segment: Range;
}

export interface VerifiedTransaction {
  /// The plan message that the transaction proves. A signer compares it with the message it signs.
  message: string;
  intents: VerifiedIntent[];
  /// The positions of the instructions that no segment holds, other than ComputeBudget ones.
  unverified: number[];
}

/// An account with its data decoded. `null` stands for an account that does not exist.
export interface Account {
  owner: string;
  lamports: bigint;
  data: Uint8Array;
}

export type VerifyStep = { fetch: string[] } | { verified: VerifiedTransaction };

export class VerifyError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

/// One round for the lookup tables, then the rounds that the Rust client allows.
const MAX_ROUNDS = 9;
/// `getMultipleAccounts` takes at most 100 addresses.
const MAX_ACCOUNTS_PER_FETCH = 100;

interface Exports {
  memory: WebAssembly.Memory;
  input(len: number): number;
  verify(): number;
  output(): number;
}

type Answer = VerifyStep | { error: { code: string; message: string } };

export class Verifier {
  readonly #exports: Exports;

  private constructor(exports: Exports) {
    this.#exports = exports;
  }

  /// Loads the module from its bytes, or fetches it from a URL. In Node, pass the bytes of
  /// `@sdp/intents-verifier/verifier.wasm`, because `fetch` does not read files.
  static async load(module: BufferSource | URL | string): Promise<Verifier> {
    const bytes =
      module instanceof URL || typeof module === "string" ? await fetchModule(module) : module;
    const { instance } = await WebAssembly.instantiate(bytes);

    return new Verifier(exportsOf(instance));
  }

  /// One step with no IO: the accounts to fetch next, or what `message` proves. `accounts` holds
  /// every account that the earlier steps asked for.
  step(message: Uint8Array, accounts: ReadonlyMap<string, Account | null>): VerifyStep {
    const input = encodeInput(message, accounts);
    const exports = this.#exports;
    // `input` can grow the memory, which detaches the old buffer, so the buffer is read after it.
    const inputAt = exports.input(input.length) >>> 0;
    new Uint8Array(exports.memory.buffer, inputAt, input.length).set(input);

    const length = exports.verify() >>> 0;
    const output = new Uint8Array(exports.memory.buffer, exports.output() >>> 0, length);
    const answer = JSON.parse(new TextDecoder().decode(output)) as Answer;

    if ("error" in answer) {
      throw new VerifyError(answer.error.code, answer.error.message);
    }

    return answer;
  }

  /// Runs each step, and answers its fetches with `getMultipleAccounts` on `rpc`.
  async verifyMessage(message: Uint8Array, rpc: string): Promise<VerifiedTransaction> {
    const accounts = new Map<string, Account | null>();

    for (let round = 0; round < MAX_ROUNDS; round += 1) {
      const step = this.step(message, accounts);

      if ("verified" in step) return step.verified;

      const fetched = await getMultipleAccounts(rpc, step.fetch);
      for (const [index, address] of step.fetch.entries()) {
        accounts.set(address, fetched[index] ?? null);
      }
    }

    throw new VerifyError(
      "tooManyRounds",
      `the verifier asked for accounts in more than ${MAX_ROUNDS} rounds`
    );
  }
}

async function fetchModule(url: URL | string): Promise<ArrayBuffer> {
  const response = await fetch(url);

  if (!response.ok) {
    throw new VerifyError("noModule", `the verifier module at ${url} answered ${response.status}`);
  }

  return response.arrayBuffer();
}

function exportsOf(instance: WebAssembly.Instance): Exports {
  const { memory, input, verify, output } = instance.exports;

  if (
    !(memory instanceof WebAssembly.Memory) ||
    typeof input !== "function" ||
    typeof verify !== "function" ||
    typeof output !== "function"
  ) {
    throw new VerifyError("noModule", "the module is not the SDP verifier");
  }

  return {
    memory,
    input: (len) => Number(input(len)),
    verify: () => Number(verify()),
    output: () => Number(output()),
  };
}

/// The input layout of `intents/crates/verifier-wasm/src/lib.rs`.
function encodeInput(
  message: Uint8Array,
  accounts: ReadonlyMap<string, Account | null>
): Uint8Array {
  const text = new TextEncoder();
  const address = (base58: string) => {
    const bytes = text.encode(base58);

    return [Uint8Array.of(bytes.length), bytes];
  };
  const entry = ([key, account]: [string, Account | null]) =>
    account === null
      ? [...address(key), Uint8Array.of(0)]
      : [
          ...address(key),
          Uint8Array.of(1),
          ...address(account.owner),
          u64(account.lamports),
          u32(account.data.length),
          account.data,
        ];
  const parts = [u32(message.length), message, u32(accounts.size), ...[...accounts].flatMap(entry)];
  const input = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let offset = 0;

  for (const part of parts) {
    input.set(part, offset);
    offset += part.length;
  }

  return input;
}

function u32(value: number): Uint8Array {
  const bytes = new Uint8Array(4);
  new DataView(bytes.buffer).setUint32(0, value, true);

  return bytes;
}

function u64(value: bigint): Uint8Array {
  const bytes = new Uint8Array(8);
  new DataView(bytes.buffer).setBigUint64(0, value, true);

  return bytes;
}

interface RpcAccount {
  owner: string;
  lamports: number;
  data: [string, "base64"];
}

/// Reads at `processed`, as the Rust client and the service do.
async function getMultipleAccounts(rpc: string, addresses: string[]): Promise<(Account | null)[]> {
  const chunks = Array.from(
    { length: Math.ceil(addresses.length / MAX_ACCOUNTS_PER_FETCH) },
    (_, index) =>
      addresses.slice(index * MAX_ACCOUNTS_PER_FETCH, (index + 1) * MAX_ACCOUNTS_PER_FETCH)
  );
  const answers = await Promise.all(chunks.map((chunk) => fetchChunk(rpc, chunk)));

  return answers.flat();
}

async function fetchChunk(rpc: string, addresses: string[]): Promise<(Account | null)[]> {
  const response = await fetch(rpc, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "getMultipleAccounts",
      params: [addresses, { encoding: "base64", commitment: "processed" }],
    }),
  });
  const body = (await response.json()) as {
    result?: { value: (RpcAccount | null)[] };
    error?: { message: string };
  };

  if (body.result === undefined || body.result.value.length !== addresses.length) {
    throw new VerifyError(
      "rpc",
      `getMultipleAccounts failed: ${body.error?.message ?? response.status}`
    );
  }

  return body.result.value.map((account) =>
    account === null
      ? null
      : {
          owner: account.owner,
          lamports: BigInt(account.lamports),
          data: Uint8Array.from(atob(account.data[0]), (character) => character.charCodeAt(0)),
        }
  );
}
