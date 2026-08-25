import { HeliusRingsError } from "@sdp/helius-rings";
import type { SolanaRpc } from "@sdp/rpc/solana";
import * as solanaRpc from "@sdp/rpc/solana";
import {
  type Address,
  type Blockhash,
  compileTransaction,
  createTransactionMessage,
  getBase58Codec,
  getBase64Codec,
  getTransactionEncoder,
  pipe,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
} from "@solana/kit";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Env } from "@/types/env";
import { RingsAdapterError } from "./adapter-error";
import {
  inspectRingsSignature,
  readRingsBlockHeight,
  submitRingsOuterTransaction,
} from "./rpc-adapter";

const FEE_PAYER = "11111111111111111111111111111111" as Address;
const BLOCKHASH = getBase58Codec().decode(new Uint8Array(32).fill(7)) as Blockhash;

const COMPETING_RPC_ENV = {
  SOLANA_NETWORK: "devnet",
  SOLANA_RPC_DEFAULT_PROVIDER: "triton",
  SOLANA_RPC_URL: "https://default.example.invalid",
  SOLANA_RPC_TRITON_URL: "https://triton.example.invalid/{API_KEY}",
  SOLANA_RPC_TRITON_API_KEY: "triton-secret",
  SOLANA_RPC_HELIUS_URL: "https://helius.example.invalid/?api-key={API_KEY}",
  SOLANA_RPC_HELIUS_API_KEY: "helius secret",
} as unknown as Env;

const HELIUS_RPC_URL = "https://helius.example.invalid/?api-key=helius%20secret";

function signedTxBase64(): string {
  const message = pipe(
    createTransactionMessage({ version: 0 }),
    (current) => setTransactionMessageFeePayer(FEE_PAYER, current),
    (current) =>
      setTransactionMessageLifetimeUsingBlockhash(
        { blockhash: BLOCKHASH, lastValidBlockHeight: 100n },
        current
      )
  );
  return getBase64Codec().decode(getTransactionEncoder().encode(compileTransaction(message)));
}

function submissionRpc(): SolanaRpc {
  return {
    sendTransaction: () => ({ send: async () => "sig_abc" }),
  } as unknown as SolanaRpc;
}

function inspectionRpc(): SolanaRpc {
  return {
    isBlockhashValid: () => ({ send: async () => ({ value: false }) }),
    getSignatureStatuses: () => ({ send: async () => ({ value: [null] }) }),
    getTransaction: () => ({ send: async () => null }),
  } as unknown as SolanaRpc;
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("Rings Helius RPC routing", () => {
  it("submits through Helius even when Triton is the default provider", async () => {
    const createRpc = vi.spyOn(solanaRpc, "createRpc").mockReturnValue(submissionRpc());

    await submitRingsOuterTransaction({
      env: COMPETING_RPC_ENV,
      signedTxBase64: signedTxBase64(),
    });

    expect(createRpc).toHaveBeenCalledOnce();
    expect(createRpc).toHaveBeenCalledWith(COMPETING_RPC_ENV, { rpcUrl: HELIUS_RPC_URL });
  });

  it("reads block height through Helius even when Triton is the default provider", async () => {
    const rpc = {
      getBlockHeight: () => ({ send: async () => 123n }),
    } as unknown as SolanaRpc;
    const createRpc = vi.spyOn(solanaRpc, "createRpc").mockReturnValue(rpc);

    await expect(readRingsBlockHeight({ env: COMPETING_RPC_ENV })).resolves.toBe("123");
    expect(createRpc).toHaveBeenCalledOnce();
    expect(createRpc).toHaveBeenCalledWith(COMPETING_RPC_ENV, { rpcUrl: HELIUS_RPC_URL });
  });

  it("inspects reconcile history through Helius even when Triton is the default provider", async () => {
    const createRpc = vi.spyOn(solanaRpc, "createRpc").mockReturnValue(inspectionRpc());

    await inspectRingsSignature({
      env: COMPETING_RPC_ENV,
      signature: "sig",
      signedTxBase64: signedTxBase64(),
    });

    expect(createRpc).toHaveBeenCalledOnce();
    expect(createRpc).toHaveBeenCalledWith(COMPETING_RPC_ENV, { rpcUrl: HELIUS_RPC_URL });
  });

  it("sends a real transport request to the substituted Helius path", async () => {
    const env = {
      ...COMPETING_RPC_ENV,
      SOLANA_RPC_HELIUS_URL: "https://helius.example.invalid/rpc/{API_KEY}",
      SOLANA_RPC_HELIUS_API_KEY: "path key/segment",
    } as unknown as Env;
    let target = "";
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const request = input instanceof Request ? input : new Request(input, init);
        target = request.url;
        const payload = (await request.clone().json()) as { id: string | number };
        return new Response(JSON.stringify({ jsonrpc: "2.0", id: payload.id, result: 789 }), {
          headers: { "Content-Type": "application/json" },
        });
      })
    );

    await expect(readRingsBlockHeight({ env })).resolves.toBe("789");
    expect(target).toBe("https://helius.example.invalid/rpc/path%20key%2Fsegment");
  });

  it("redacts a substituted Helius key from a path-bearing RPC error", async () => {
    const secret = "path key/segment";
    const encodedSecret = "path%20key%2Fsegment";
    const env = {
      ...COMPETING_RPC_ENV,
      SOLANA_RPC_HELIUS_URL: "https://helius.example.invalid/rpc/{API_KEY}",
      SOLANA_RPC_HELIUS_API_KEY: secret,
    } as unknown as Env;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const request = input instanceof Request ? input : new Request(input, init);
        throw new Error(`request failed for ${request.url}: upstream unavailable`);
      })
    );

    const error = await submitRingsOuterTransaction({
      env,
      signedTxBase64: signedTxBase64(),
    }).then(
      () => null,
      (thrown: unknown) => thrown
    );

    expect(error).toBeInstanceOf(RingsAdapterError);
    expect((error as Error).message).toContain("https://helius.example.invalid/rpc/");
    expect((error as Error).message).not.toContain(secret);
    expect((error as Error).message).not.toContain(encodedSecret);
  });

  it("redacts a pre-embedded Helius path key without a separate key", async () => {
    const secret = "pre-embedded-secret";
    const env = {
      ...COMPETING_RPC_ENV,
      SOLANA_RPC_HELIUS_URL: `https://helius.example.invalid/rpc/${secret}`,
      SOLANA_RPC_HELIUS_API_KEY: undefined,
    } as unknown as Env;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const request = input instanceof Request ? input : new Request(input, init);
        throw new Error(`request failed for ${request.url}: upstream unavailable`);
      })
    );

    const error = await submitRingsOuterTransaction({
      env,
      signedTxBase64: signedTxBase64(),
    }).then(
      () => null,
      (thrown: unknown) => thrown
    );

    expect(error).toBeInstanceOf(RingsAdapterError);
    expect((error as Error).message).toContain("https://helius.example.invalid/");
    expect((error as Error).message).not.toContain(secret);
  });

  it("fails submission closed with config_error when the Helius URL is missing", async () => {
    const secret = "must-not-leak";
    const env = {
      ...COMPETING_RPC_ENV,
      SOLANA_RPC_HELIUS_URL: undefined,
      SOLANA_RPC_HELIUS_API_KEY: secret,
    } as unknown as Env;
    const createRpc = vi.spyOn(solanaRpc, "createRpc").mockImplementation(() => {
      throw new Error("generic RPC selected");
    });

    const error = await submitRingsOuterTransaction({
      env,
      signedTxBase64: signedTxBase64(),
    }).then(
      () => null,
      (thrown: unknown) => thrown
    );

    expect(error).toBeInstanceOf(HeliusRingsError);
    expect(error).toMatchObject({ code: "config_error" });
    expect((error as Error).message).toContain("SOLANA_RPC_HELIUS_URL");
    expect((error as Error).message).not.toContain(secret);
    expect(createRpc).not.toHaveBeenCalled();
  });

  it("fails reconcile inspection closed when the Helius key placeholder is unresolved", async () => {
    const env = {
      ...COMPETING_RPC_ENV,
      SOLANA_RPC_HELIUS_API_KEY: undefined,
    } as unknown as Env;
    const createRpc = vi.spyOn(solanaRpc, "createRpc").mockImplementation(() => {
      throw new Error("generic RPC selected");
    });

    const error = await inspectRingsSignature({
      env,
      signature: "sig",
      signedTxBase64: signedTxBase64(),
    }).then(
      () => null,
      (thrown: unknown) => thrown
    );

    expect(error).toBeInstanceOf(HeliusRingsError);
    expect(error).toMatchObject({ code: "config_error" });
    expect((error as Error).message).toContain("SOLANA_RPC_HELIUS_API_KEY");
    expect((error as Error).message).not.toContain("triton-secret");
    expect(createRpc).not.toHaveBeenCalled();
  });

  it("treats missing Helius configuration as unavailable for the block-height sweep", async () => {
    const env = {
      ...COMPETING_RPC_ENV,
      SOLANA_RPC_HELIUS_URL: undefined,
    } as unknown as Env;
    const createRpc = vi.spyOn(solanaRpc, "createRpc").mockImplementation(() => {
      throw new Error("generic RPC selected");
    });

    await expect(readRingsBlockHeight({ env })).resolves.toBeNull();
    expect(createRpc).not.toHaveBeenCalled();
  });

  it("keeps an injected RPC independent of Helius configuration", async () => {
    const rpc = {
      getBlockHeight: () => ({ send: async () => 456n }),
    } as unknown as SolanaRpc;
    const createRpc = vi.spyOn(solanaRpc, "createRpc");

    await expect(readRingsBlockHeight({ env: {} as Env, rpc })).resolves.toBe("456");
    expect(createRpc).not.toHaveBeenCalled();
  });
});
