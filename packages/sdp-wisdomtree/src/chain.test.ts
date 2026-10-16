import { withMinimumRpcSlot } from "@sdp/rpc/read-context";
import { SPL_TOKEN_PROGRAMS, wellKnownMint } from "@sdp/types";
import {
  WISDOMTREE_FUNDS,
  WISDOMTREE_TRANSFER_HOOK_PROGRAM_IDS,
} from "@sdp/types/wisdomtree-programs";
import { address, createNoopSigner, getAddressEncoder } from "@solana/kit";
import { findAssociatedTokenPda } from "@solana-program/token-2022";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createWisdomTreeChainReader } from "./chain";
import {
  extraAccountMetaListAccount,
  literalHookEntry,
  tokenAccountData,
  wtgxxMintAccountData,
} from "./fixtures.test-helper";
import { buildWisdomTreeDepositPlan, buildWisdomTreeRedemptionPlan } from "./plan";
import { deriveExtraAccountMetasAddress } from "./transfer-hook";
import type { WisdomTreeRuntime } from "./types";

const WTGXX = WISDOMTREE_FUNDS[0];
const HOOK = WISDOMTREE_TRANSFER_HOOK_PROGRAM_IDS["mainnet-beta"] as string;
const USDC = wellKnownMint("USDC", "mainnet-beta") as string;
const TOKEN_2022 = SPL_TOKEN_PROGRAMS["token-2022"];
const OWNER = "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr";
const ON_RECEIPT = "ComputeBudget111111111111111111111111111111";
const RPC_URL = "http://rpc.invalid";
const SLOT = 7;
const runtime: WisdomTreeRuntime = { cluster: "mainnet-beta", rpcUrl: RPC_URL };
const encoder = getAddressEncoder();

type Accounts = Record<string, { owner: string; data: Uint8Array }>;

function wire(account: { owner: string; data: Uint8Array } | undefined) {
  if (!account) return null;
  return {
    data: [Buffer.from(account.data).toString("base64"), "base64"],
    executable: false,
    lamports: 1,
    owner: account.owner,
    rentEpoch: 0,
    space: account.data.length,
  };
}

function answer(accounts: Accounts, init: RequestInit | undefined): Response {
  const body = JSON.parse(String(init?.body)) as { id: unknown; method: string; params: unknown[] };
  const context = { slot: SLOT };
  const result =
    body.method === "getMultipleAccounts"
      ? { context, value: (body.params[0] as string[]).map((key) => wire(accounts[key])) }
      : { context, value: wire(accounts[String(body.params[0])]) };
  return Response.json({ jsonrpc: "2.0", id: body.id, result });
}

/** Serves `accounts` to kit through a stubbed global fetch; `failures` reject the first calls. */
function stubChain(accounts: Accounts, failures: Error[] = []) {
  const queued = [...failures];
  const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
    const failure = queued.shift();
    if (failure) throw failure;
    return answer(accounts, init);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function sentBodies(fetchMock: ReturnType<typeof stubChain>) {
  return fetchMock.mock.calls.map(
    ([, init]) => JSON.parse(String(init?.body)) as { method: string; params: unknown[] }
  );
}

function socketDeath(): TypeError {
  return new TypeError("fetch failed", {
    cause: Object.assign(new Error("other side closed"), { code: "UND_ERR_SOCKET" }),
  });
}

async function ata(owner: string, mint: string, tokenProgram: string): Promise<string> {
  const [derived] = await findAssociatedTokenPda({
    owner: address(owner),
    mint: address(mint),
    tokenProgram: address(tokenProgram),
  });
  return String(derived);
}

/** A Token-2022 fund account naming `owner` in the owner field hook seeds slice. */
function fundAccount(owner: string): Uint8Array {
  const data = tokenAccountData(1_000_000_000n);
  data.set(encoder.encode(address(WTGXX.mint)), 0);
  data.set(encoder.encode(address(owner)), 32);
  return data;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("createWisdomTreeChainReader", () => {
  it("reads several accounts in one getMultipleAccounts, in the order asked", async () => {
    const fetchMock = stubChain({ [OWNER]: { owner: TOKEN_2022, data: Uint8Array.from([1, 2]) } });
    await expect(
      createWisdomTreeChainReader(RPC_URL).getAccounts([address(OWNER), address(ON_RECEIPT)])
    ).resolves.toEqual([{ owner: TOKEN_2022, data: Uint8Array.from([1, 2]) }, null]);
    expect(sentBodies(fetchMock)).toEqual([
      expect.objectContaining({
        method: "getMultipleAccounts",
        params: [[OWNER, ON_RECEIPT], { commitment: "confirmed", encoding: "base64" }],
      }),
    ]);
  });

  it("re-sends a read once when its pooled socket died before any response", async () => {
    const fetchMock = stubChain({ [OWNER]: { owner: TOKEN_2022, data: Uint8Array.from([3]) } }, [
      socketDeath(),
    ]);
    await expect(createWisdomTreeChainReader(RPC_URL).getAccount(address(OWNER))).resolves.toEqual({
      owner: TOKEN_2022,
      data: Uint8Array.from([3]),
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("keeps the minimum-slot scope on the re-sent read", async () => {
    const fetchMock = stubChain({}, [socketDeath()]);
    await withMinimumRpcSlot(SLOT, () =>
      createWisdomTreeChainReader(RPC_URL).getAccounts([address(OWNER)])
    );
    expect(sentBodies(fetchMock).map((body) => body.params[1])).toEqual([
      expect.objectContaining({ commitment: "confirmed", minContextSlot: SLOT }),
      expect.objectContaining({ commitment: "confirmed", minContextSlot: SLOT }),
    ]);
  });

  it("does not re-send any other transport failure", async () => {
    const refused = new TypeError("fetch failed", {
      cause: Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }),
    });
    const fetchMock = stubChain({}, [refused]);
    await expect(
      createWisdomTreeChainReader(RPC_URL).getAccount(address(OWNER))
    ).rejects.toMatchObject({ code: "VAULT_UNREADABLE" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("WisdomTree builds through the real chain reader", () => {
  it("builds a deposit in one RPC request", async () => {
    const fetchMock = stubChain({
      [WTGXX.mint]: { owner: TOKEN_2022, data: wtgxxMintAccountData() },
    });
    await buildWisdomTreeDepositPlan(createWisdomTreeChainReader(RPC_URL), runtime, {
      fund: WTGXX,
      owner: createNoopSigner(address(OWNER)),
      onReceiptWallet: address(ON_RECEIPT),
      depositMint: address(USDC),
      depositDecimals: 6,
      amount: "25.5",
    });
    expect(sentBodies(fetchMock).map((body) => body.method)).toEqual(["getMultipleAccounts"]);
  });

  it("builds a redemption whose hook seeds come from the batched accounts in one request", async () => {
    const validation = await deriveExtraAccountMetasAddress(address(HOOK), address(WTGXX.mint));
    const sourceOwnerEntry = new Uint8Array(35);
    sourceOwnerEntry[0] = 1; // a PDA on the hook program
    sourceOwnerEntry[1] = 4; // account-data seed tag
    sourceOwnerEntry[2] = 0; // execute index 0 = source token account
    sourceOwnerEntry[3] = 32; // the token account's owner field
    sourceOwnerEntry[4] = 32;
    const fetchMock = stubChain({
      [WTGXX.mint]: { owner: TOKEN_2022, data: wtgxxMintAccountData() },
      [String(validation)]: {
        owner: HOOK,
        data: extraAccountMetaListAccount([literalHookEntry(USDC), sourceOwnerEntry]),
      },
      [await ata(OWNER, WTGXX.mint, TOKEN_2022)]: { owner: TOKEN_2022, data: fundAccount(OWNER) },
      [await ata(ON_RECEIPT, WTGXX.mint, TOKEN_2022)]: {
        owner: TOKEN_2022,
        data: fundAccount(ON_RECEIPT),
      },
    });
    const plan = await buildWisdomTreeRedemptionPlan(
      createWisdomTreeChainReader(RPC_URL),
      runtime,
      {
        fund: WTGXX,
        owner: createNoopSigner(address(OWNER)),
        onReceiptWallet: address(ON_RECEIPT),
        depositMint: address(USDC),
        shares: "1",
      }
    );
    expect(plan.instructions.at(-1)?.accounts).toHaveLength(8);
    expect(sentBodies(fetchMock).map((body) => body.method)).toEqual(["getMultipleAccounts"]);
  });
});
