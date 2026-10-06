import {
  readStamp,
  withMinimumRpcSlot,
  withReadFloor,
  withRpcReadContextFetch,
} from "@sdp/rpc/read-context";
import { JUPITER_LEND_EARN_PROGRAM_IDS, JUPITER_LEND_USDT } from "@sdp/types/jupiter-lend-programs";
import { PublicKey } from "@solana/web3.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  JUPITER_LEND_SHARED_READ_JOIN_WINDOW_MS,
  jupiterLendConnection,
  withJupiterLendReadSharing,
} from "./rpc";

interface Sent {
  url: string;
  body: { method: string; params: unknown[] };
  resolve: (response: Response) => void;
  reject: (error: unknown) => void;
}

/** A send that records every request and settles only when told to. */
function fakeSend() {
  const sent: Sent[] = [];
  const send = ((input: Parameters<typeof fetch>[0], init?: RequestInit) =>
    new Promise<Response>((resolve, reject) => {
      sent.push({ url: String(input), body: JSON.parse(String(init?.body)), resolve, reject });
    })) as typeof fetch;
  return { sent, send };
}

let nextId = 0;
function post(method: string, params: unknown[], signal?: AbortSignal): RequestInit {
  nextId += 1;
  return {
    method: "POST",
    body: JSON.stringify({ jsonrpc: "2.0", id: String(nextId), method, params }),
    ...(signal ? { signal } : {}),
  };
}

const RPC = "https://rpc.example.invalid";
const ACCOUNT = "11111111111111111111111111111112";
const answer = (result: unknown) =>
  new Response(JSON.stringify({ jsonrpc: "2.0", id: "1", result }), { status: 200 });
const supply = (slot: number) =>
  answer({
    context: { slot },
    value: { amount: "7", decimals: 6, uiAmount: 0, uiAmountString: "0" },
  });
/** A later macrotask: past anything a client coalesces within one tick. */
const laterTask = () => new Promise((resolve) => setTimeout(resolve, 0));

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("withJupiterLendReadSharing", () => {
  it("shares one in-flight response among identical reads", async () => {
    const { sent, send } = fakeSend();
    const read = withJupiterLendReadSharing(send);

    const first = read(RPC, post("getAccountInfo", [ACCOUNT, { encoding: "base64" }]));
    await laterTask();
    const second = read(RPC, post("getAccountInfo", [ACCOUNT, { encoding: "base64" }]));
    expect(sent).toHaveLength(1);

    sent[0]?.resolve(answer({ context: { slot: 9 }, value: null }));
    const [one, two] = await Promise.all([first, second]);
    expect(await one.text()).toBe(await two.text());
  });

  it("never lets a caller join a read sent before its read floor", async () => {
    const { sent, send } = fakeSend();
    const read = withJupiterLendReadSharing(send);
    const body = () => post("getAccountInfo", [ACCOUNT, { encoding: "base64" }]);

    const before = read(RPC, body());
    const rowsReadAt = readStamp();
    const floored = withReadFloor(rowsReadAt, () => read(RPC, body()));
    // The fresh read replaces the stale entry: later callers share it.
    const unfloored = read(RPC, body());
    expect(sent).toHaveLength(2);

    sent[0]?.resolve(answer({ context: { slot: 1 }, value: null }));
    sent[1]?.resolve(answer({ context: { slot: 2 }, value: null }));
    expect(await (await before).text()).toContain('"slot":1');
    expect(await (await floored).text()).toContain('"slot":2');
    expect(await (await unfloored).text()).toContain('"slot":2');
  });

  it("lets a caller join a read sent after its read floor", () => {
    const { sent, send } = fakeSend();
    const read = withJupiterLendReadSharing(send);
    const body = () => post("getAccountInfo", [ACCOUNT, { encoding: "base64" }]);

    const rowsReadAt = readStamp();
    void read(RPC, body());
    void withReadFloor(rowsReadAt, () => read(RPC, body()));

    expect(sent).toHaveLength(1);
  });

  it("never lets a caller join a read sent a join window or more ago", async () => {
    const { sent, send } = fakeSend();
    const read = withJupiterLendReadSharing(send);
    const body = () => post("getAccountInfo", [ACCOUNT, { encoding: "base64" }]);
    const clock = vi.spyOn(Date, "now").mockReturnValue(10_000);

    const stalled = read(RPC, body());
    clock.mockReturnValue(10_000 + JUPITER_LEND_SHARED_READ_JOIN_WINDOW_MS - 1);
    const joined = read(RPC, body());
    expect(sent).toHaveLength(1);
    clock.mockReturnValue(10_000 + JUPITER_LEND_SHARED_READ_JOIN_WINDOW_MS);
    const later = read(RPC, body());
    expect(sent).toHaveLength(2);

    sent[1]?.resolve(answer({ context: { slot: 2 }, value: null }));
    expect(await (await later).text()).toContain('"slot":2');
    sent[0]?.resolve(answer({ context: { slot: 1 }, value: null }));
    expect(await (await stalled).text()).toContain('"slot":1');
    expect(await (await joined).text()).toContain('"slot":1');
  });

  it("keeps reads apart when the URL, method or params differ", async () => {
    const { sent, send } = fakeSend();
    const read = withJupiterLendReadSharing(send);

    void read(RPC, post("getAccountInfo", [ACCOUNT]));
    void read(`${RPC}/other`, post("getAccountInfo", [ACCOUNT]));
    void read(RPC, post("getTokenSupply", [ACCOUNT]));
    void read(RPC, post("getAccountInfo", [ACCOUNT, { minContextSlot: 5 }]));

    expect(sent).toHaveLength(4);
  });

  it.each(["sendTransaction", "simulateTransaction", "getLatestBlockhash", "getSlot"])(
    "never shares %s",
    async (method) => {
      const { sent, send } = fakeSend();
      const read = withJupiterLendReadSharing(send);
      void read(RPC, post(method, ["AQID"]));
      void read(RPC, post(method, ["AQID"]));
      expect(sent).toHaveLength(2);
    }
  );

  it("never shares a request that carries a signal", async () => {
    const { sent, send } = fakeSend();
    const read = withJupiterLendReadSharing(send);
    void read(RPC, post("getAccountInfo", [ACCOUNT], new AbortController().signal));
    void read(RPC, post("getAccountInfo", [ACCOUNT]));
    expect(sent).toHaveLength(2);
  });

  it("re-sends a read once the earlier one has settled", async () => {
    const { sent, send } = fakeSend();
    const read = withJupiterLendReadSharing(send);

    const first = read(RPC, post("getAccountInfo", [ACCOUNT]));
    sent[0]?.resolve(answer({ context: { slot: 1 }, value: null }));
    await first;
    void read(RPC, post("getAccountInfo", [ACCOUNT]));

    expect(sent).toHaveLength(2);
  });

  it("rejects every joiner of a failed read and forgets it", async () => {
    const { sent, send } = fakeSend();
    const read = withJupiterLendReadSharing(send);
    const failure = new Error("socket hang up");

    const first = read(RPC, post("getAccountInfo", [ACCOUNT]));
    const second = read(RPC, post("getAccountInfo", [ACCOUNT]));
    sent[0]?.reject(failure);
    await expect(first).rejects.toBe(failure);
    await expect(second).rejects.toBe(failure);

    void read(RPC, post("getAccountInfo", [ACCOUNT]));
    expect(sent).toHaveLength(2);
  });

  it("never shares across read scopes, even where the request bytes match", async () => {
    const { sent, send } = fakeSend();
    const read = withRpcReadContextFetch(withJupiterLendReadSharing(send));
    const request = () => post("getTokenSupply", [ACCOUNT, { commitment: "confirmed" }]);
    const settle = (response: Promise<Response>) => response.then((value) => value.json());

    const reads = [
      settle(read(RPC, request())),
      withMinimumRpcSlot(100, () => settle(read(RPC, request()))),
      withMinimumRpcSlot(100, () => settle(read(RPC, request()))),
      withMinimumRpcSlot(200, () => settle(read(RPC, request()))),
    ];
    await laterTask();

    // getTokenSupply cannot carry minContextSlot, so all four bodies are equal.
    expect(new Set(sent.map((entry) => JSON.stringify(entry.body.params))).size).toBe(1);
    expect(sent).toHaveLength(3);
    for (const entry of sent) entry.resolve(supply(250));
    await expect(Promise.all(reads)).resolves.toHaveLength(4);
  });
});

describe("jupiterLendConnection", () => {
  const LENDING_PROGRAM = new PublicKey(JUPITER_LEND_EARN_PROGRAM_IDS["mainnet-beta"]);
  // The SDK's PDA [lending, USDT, jlUSDT] for the admitted market.
  const LENDING_PDA = "F7tLdeF2YZZex9MR8HgGggyFiz7UU2UgUube2tmfwNPE";
  const lookup = {
    commitment: "confirmed" as const,
    filters: [
      { memcmp: { offset: 0, bytes: "PiDuNSLmEPr" } },
      { memcmp: { bytes: JUPITER_LEND_USDT.shareMint, offset: 40 } },
    ],
  };

  function lendingAccount(shareMint: string = JUPITER_LEND_USDT.shareMint) {
    const data = Buffer.alloc(196);
    Buffer.from([135, 199, 82, 16, 249, 131, 182, 241]).copy(data, 0);
    new PublicKey(JUPITER_LEND_USDT.assetMint).toBuffer().copy(data, 8);
    new PublicKey(shareMint).toBuffer().copy(data, 40);
    return {
      data: [data.toString("base64"), "base64"],
      executable: false,
      lamports: 2_255_040,
      owner: LENDING_PROGRAM.toBase58(),
      rentEpoch: 0,
      space: 196,
    };
  }

  function stubRpc(answers: (method: string, params: unknown[]) => unknown) {
    const methods: string[] = [];
    const fetch = vi.fn(async (_input: unknown, init?: RequestInit) => {
      const request = JSON.parse(String(init?.body)) as { method: string; params: unknown[] };
      methods.push(request.method);
      const result = answers(request.method, request.params);
      if (result instanceof Response) return result;
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: "1", result }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetch);
    return methods;
  }

  it("keeps one Connection per RPC URL", () => {
    expect(jupiterLendConnection(`${RPC}/a`)).toBe(jupiterLendConnection(`${RPC}/a`));
    expect(jupiterLendConnection(`${RPC}/a`)).not.toBe(jupiterLendConnection(`${RPC}/b`));
  });

  it("keeps only the 32 most recently used Connections", () => {
    const url = (index: number) => `${RPC}/lru/${index}`;
    const first = Array.from({ length: 32 }, (_, index) => jupiterLendConnection(url(index)));
    expect(jupiterLendConnection(url(0))).toBe(first[0]);
    jupiterLendConnection(url(32));
    expect(jupiterLendConnection(url(0))).toBe(first[0]);
    expect(jupiterLendConnection(url(2))).toBe(first[2]);
    expect(jupiterLendConnection(url(1))).not.toBe(first[1]);
  });

  it("retries a 429 with web3.js's default backoff", async () => {
    vi.useFakeTimers();
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    let calls = 0;
    const methods = stubRpc(() => {
      calls += 1;
      return calls === 1
        ? new Response("rate limited", { status: 429, statusText: "Too Many Requests" })
        : { context: { slot: 3 }, value: null };
    });
    const read = jupiterLendConnection(`${RPC}/limited`).getAccountInfo(new PublicKey(ACCOUNT));
    await vi.advanceTimersByTimeAsync(500);
    await expect(read).resolves.toBeNull();
    expect(methods).toEqual(["getAccountInfo", "getAccountInfo"]);
  });

  it("re-sends a read once when its socket dies, for every joined reader", async () => {
    const socketDeath = new TypeError("fetch failed", {
      cause: Object.assign(new Error("other side closed"), { code: "UND_ERR_SOCKET" }),
    });
    let attempts = 0;
    const fetch = vi.fn(async () => {
      attempts += 1;
      const attempt = attempts;
      await laterTask();
      if (attempt === 1) throw socketDeath;
      return answer({ context: { slot: 3 }, value: null });
    });
    vi.stubGlobal("fetch", fetch);
    const connection = jupiterLendConnection(`${RPC}/socket`);
    const account = new PublicKey(ACCOUNT);
    await expect(
      Promise.all([connection.getAccountInfo(account), connection.getAccountInfo(account)])
    ).resolves.toEqual([null, null]);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("answers the SDK's USDT lending lookup with one read of the lending PDA", async () => {
    const methods = stubRpc((method, params) =>
      method === "getAccountInfo" && params[0] === LENDING_PDA
        ? { context: { slot: 3 }, value: lendingAccount() }
        : undefined
    );
    const accounts = await jupiterLendConnection(`${RPC}/lookup`).getProgramAccounts(
      LENDING_PROGRAM,
      lookup
    );
    expect(methods).toEqual(["getAccountInfo"]);
    expect(accounts.map((entry) => entry.pubkey.toBase58())).toEqual([LENDING_PDA]);
    expect(accounts[0]?.account.owner.equals(LENDING_PROGRAM)).toBe(true);
  });

  it.each([
    ["missing", null],
    ["for another share mint", lendingAccount(ACCOUNT)],
  ])("runs the real scan when the PDA is %s", async (_case, value) => {
    const methods = stubRpc((method) =>
      method === "getAccountInfo" ? { context: { slot: 3 }, value } : []
    );
    await expect(
      jupiterLendConnection(`${RPC}/fallback`).getProgramAccounts(LENDING_PROGRAM, lookup)
    ).resolves.toEqual([]);
    expect(methods).toEqual(["getAccountInfo", "getProgramAccounts"]);
  });

  it("passes every other program-account query straight through", async () => {
    const methods = stubRpc(() => []);
    const connection = jupiterLendConnection(`${RPC}/other`);
    await connection.getProgramAccounts(LENDING_PROGRAM, { filters: lookup.filters.slice(0, 1) });
    await connection.getProgramAccounts(LENDING_PROGRAM, {
      ...lookup,
      dataSlice: { offset: 0, length: 8 },
    });
    await connection.getProgramAccounts(new PublicKey(ACCOUNT), lookup);
    expect(methods).toEqual(["getProgramAccounts", "getProgramAccounts", "getProgramAccounts"]);
  });
});
