/**
 * Observed-transfer amount conversion must be Token-2022 extension-aware.
 *
 * `includeObserved` synthesizes confirmed transfer rows from parsed RPC
 * transactions. For mints whose UI amount is mutated on-chain by an extension
 * (`ScaledUiAmountConfig`, `InterestBearingConfig`), a decimals-only
 * conversion reports the wrong amount while the row still says "confirmed",
 * so the builder has to resolve the mint's extension state and the
 * historical clock (the confirming block time) before synthesizing a row.
 *
 * The tests speak to a controlled HTTP JSON-RPC boundary (no function mocks
 * of the code under test): `getTransaction` serves the parsed transaction and
 * `getAccountInfo` serves the mint accounts, so both the parsed body fetch
 * and the extension-state resolution cross the same wire the production path
 * uses. Expected amounts are pinned to the `@solana-program/token-2022`
 * helpers that mirror the on-chain conversion, and a static-decimal control
 * pins the decimals-only behavior that must not change.
 */

import { createServer, type Server } from "node:http";
import { getBase58Codec, getBase64Codec, type Signature } from "@solana/kit";
import { TOKEN_PROGRAM_ADDRESS } from "@solana-program/token";
import {
  amountToUiAmountForInterestBearingMintWithoutSimulation,
  amountToUiAmountForScaledUiAmountMintWithoutSimulation,
  getMintEncoder,
  TOKEN_2022_PROGRAM_ADDRESS,
} from "@solana-program/token-2022";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  buildObservedTransfersForSignatures,
  clearObservedTransferCaches,
} from "./observed-transfers";

const base58 = getBase58Codec();
const base64 = getBase64Codec();

function testAddress(byte: number): string {
  return base58.decode(Uint8Array.from({ length: 32 }, () => byte));
}

const MINT_SCALED = testAddress(1);
const MINT_INTEREST = testAddress(2);
const MINT_STATIC_2022 = testAddress(3);
const MINT_CLASSIC = testAddress(4);
const SOURCE_TOKEN_ACCOUNT = testAddress(5);
const DESTINATION_TOKEN_ACCOUNT = testAddress(6);
const SOURCE_OWNER = testAddress(7);
const DESTINATION_OWNER = testAddress(8);
const MINT_AUTHORITY = testAddress(9);
const SIGNATURE = base58.decode(Uint8Array.from({ length: 64 }, (_, index) => (index % 251) + 1));

const DECIMALS = 6;
const BLOCK_TIME = 1_700_000_000;
const SLOT = 123_456;
const RAW_AMOUNT = 1_000_000n;

interface RpcTokenBalance {
  accountIndex: number;
  mint: string;
  owner: string;
  uiTokenAmount: { amount: string; decimals: number; uiAmountString: string };
}

interface MintAccountPayload {
  data: string;
  owner: string;
}

interface TestRpcOptions {
  /** Base64 mint-account payloads served for `getAccountInfo`; absent → account missing. */
  mintAccountsByAddress?: Record<string, MintAccountPayload | null>;
}

interface ParsedTransferTestTransaction {
  program?: string;
  type: "transfer" | "transferChecked" | "mintTo" | "mintToChecked";
  info: Record<string, unknown>;
  preTokenBalances?: RpcTokenBalance[];
  postTokenBalances?: RpcTokenBalance[];
  blockTime?: number | null;
}

/** A mint account with the given Token-2022 extensions, as `getAccountInfo` returns it. */
function encodeMintAccount(extensions: unknown[]): string {
  const bytes = getMintEncoder().encode({
    mintAuthority: null,
    supply: 0n,
    decimals: DECIMALS,
    isInitialized: true,
    freezeAuthority: null,
    extensions: extensions as never,
  });
  return base64.decode(bytes);
}

function scaledMintAccount(
  multiplier: number,
  newMultiplier?: {
    multiplier: number;
    effectiveTimestamp: bigint;
  }
): string {
  return encodeMintAccount([
    {
      __kind: "ScaledUiAmountConfig",
      authority: MINT_SCALED,
      multiplier,
      newMultiplierEffectiveTimestamp: newMultiplier?.effectiveTimestamp ?? 0n,
      newMultiplier: newMultiplier?.multiplier ?? multiplier,
    },
  ]);
}

function interestMintAccount(): string {
  return encodeMintAccount([
    {
      __kind: "InterestBearingConfig",
      rateAuthority: MINT_INTEREST,
      initializationTimestamp: 1_660_000_000n,
      preUpdateAverageRate: 500,
      lastUpdateTimestamp: 1_690_000_000n,
      currentRate: 500,
    },
  ]);
}

function tokenBalance(
  accountIndex: number,
  mint: string,
  owner: string,
  amount: bigint,
  uiAmountString: string
): RpcTokenBalance {
  return {
    accountIndex,
    mint,
    owner,
    uiTokenAmount: { amount: amount.toString(), decimals: DECIMALS, uiAmountString },
  };
}

/**
 * Starts an HTTP JSON-RPC server that serves the transaction for any
 * `getTransaction` call and the given mint accounts for `getAccountInfo`,
 * mirroring the response shapes a real RPC emits.
 */
function startTokenRpcServer(
  transaction: ParsedTransferTestTransaction,
  options: TestRpcOptions = {}
): Promise<{ url: string; close: () => Promise<void>; getAccountInfoCalls: () => string[] }> {
  const accountInfoCalls: string[] = [];
  const server: Server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => {
      body += chunk;
    });
    request.on("end", () => {
      const rpcRequest = JSON.parse(body) as { method?: string; params?: unknown[] };
      if (rpcRequest.method === "getTransaction") {
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end(
          JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            result: {
              blockTime: transaction.blockTime === undefined ? BLOCK_TIME : transaction.blockTime,
              slot: SLOT,
              meta: {
                err: null,
                fee: 5_000,
                innerInstructions: [],
                preTokenBalances: transaction.preTokenBalances ?? [],
                postTokenBalances: transaction.postTokenBalances ?? [],
              },
              transaction: {
                message: {
                  accountKeys: [
                    SOURCE_TOKEN_ACCOUNT,
                    DESTINATION_TOKEN_ACCOUNT,
                    SOURCE_OWNER,
                    DESTINATION_OWNER,
                  ],
                  instructions: [
                    {
                      program: transaction.program ?? "spl-token-2022",
                      parsed: { type: transaction.type, info: transaction.info },
                    },
                  ],
                },
              },
            },
          })
        );
        return;
      }

      if (rpcRequest.method === "getAccountInfo") {
        const mint = (rpcRequest.params as [string])[0];
        accountInfoCalls.push(mint);
        const account = options.mintAccountsByAddress?.[mint];
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end(
          JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            result: {
              context: { slot: SLOT },
              value: account
                ? {
                    data: [account.data, "base64"],
                    executable: false,
                    lamports: 1_461_600,
                    owner: account.owner,
                    rentEpoch: 0,
                    space: 286,
                  }
                : null,
            },
          })
        );
        return;
      }

      response.writeHead(400, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ error: "unexpected RPC method" }));
    });
  });

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as { port: number };
      resolve({
        url: `http://127.0.0.1:${port}`,
        close: () =>
          new Promise<void>((closeResolve, closeReject) => {
            server.close((error) => (error ? closeReject(error) : closeResolve()));
          }),
        getAccountInfoCalls: () => [...accountInfoCalls],
      });
    });
  });
}

function testEnv(rpcUrl: string) {
  return {
    ENVIRONMENT: "development",
    API_VERSION: "v1",
    SOLANA_NETWORK: "devnet",
    SOLANA_RPC_URL: rpcUrl,
  } as never;
}

function testContext(): {
  organizationId: string;
  projectId: string | null;
  walletIdsByAddress: Map<string, string>;
} {
  return {
    organizationId: "org_extension_test",
    projectId: null,
    // Only the destination wallet is a tenant wallet, so the synthesized row
    // is the inbound transfer its owner would see.
    walletIdsByAddress: new Map([[DESTINATION_OWNER, "wal_destination"]]),
  };
}

function signatureEntry(overrides: Partial<{ blockTime: bigint | null; signature: string }> = {}) {
  return {
    signature: (overrides.signature ?? SIGNATURE) as unknown as Signature,
    slot: BigInt(SLOT),
    blockTime: overrides.blockTime !== undefined ? overrides.blockTime : BigInt(BLOCK_TIME),
    err: null,
    confirmationStatus: "finalized" as const,
  };
}

function transferBalances(mint: string): {
  preTokenBalances: RpcTokenBalance[];
  postTokenBalances: RpcTokenBalance[];
} {
  return {
    preTokenBalances: [
      tokenBalance(0, mint, SOURCE_OWNER, 2_000_000n, "2"),
      tokenBalance(1, mint, DESTINATION_OWNER, 0n, "0"),
    ],
    postTokenBalances: [
      tokenBalance(0, mint, SOURCE_OWNER, 1_000_000n, "1"),
      tokenBalance(1, mint, DESTINATION_OWNER, RAW_AMOUNT, "1"),
    ],
  };
}

function plainTransfer(mint: string): ParsedTransferTestTransaction {
  return {
    type: "transfer",
    info: {
      source: SOURCE_TOKEN_ACCOUNT,
      destination: DESTINATION_TOKEN_ACCOUNT,
      authority: SOURCE_OWNER,
      amount: RAW_AMOUNT.toString(),
    },
    ...transferBalances(mint),
  };
}

const SCALED_MINT_ACCOUNT = scaledMintAccount(2);
const STATIC_2022_MINT_ACCOUNT = encodeMintAccount([]);
const CLASSIC_MINT_ACCOUNT = encodeMintAccount([]);

async function buildObservedRows(
  rpcServer: { url: string },
  signatures: Parameters<typeof buildObservedTransfersForSignatures>[1]
) {
  return buildObservedTransfersForSignatures(testEnv(rpcServer.url), signatures, testContext());
}

describe("observed Token-2022 transfer amount conversion", () => {
  beforeEach(() => {
    clearObservedTransferCaches();
  });

  afterAll(async () => {
    // vitest closes the environment; nothing persistent to tear down.
  });

  it("resolves the mint's extension state over RPC before synthesizing a row", async () => {
    const rpcServer = await startTokenRpcServer(plainTransfer(MINT_SCALED), {
      mintAccountsByAddress: {
        [MINT_SCALED]: { data: SCALED_MINT_ACCOUNT, owner: TOKEN_2022_PROGRAM_ADDRESS },
      },
    });

    try {
      const [observed] = await buildObservedRows(rpcServer, [signatureEntry()]);
      expect(observed?.status).toBe("confirmed");
      expect(observed?.direction).toBe("inbound");
      expect(observed?.token).toBe(MINT_SCALED);
      expect(rpcServer.getAccountInfoCalls()).toEqual([MINT_SCALED]);
    } finally {
      await rpcServer.close();
    }
  });

  it("converts a plain transfer on a scaled mint with the effective multiplier, not decimals", async () => {
    const rpcServer = await startTokenRpcServer(plainTransfer(MINT_SCALED), {
      mintAccountsByAddress: {
        [MINT_SCALED]: { data: SCALED_MINT_ACCOUNT, owner: TOKEN_2022_PROGRAM_ADDRESS },
      },
    });

    try {
      const [observed] = await buildObservedRows(rpcServer, [signatureEntry()]);
      expect(observed?.amount).toBe(
        amountToUiAmountForScaledUiAmountMintWithoutSimulation(RAW_AMOUNT, DECIMALS, 2)
      );
      expect(observed?.amount).toBe("2");
    } finally {
      await rpcServer.close();
    }
  });

  it("converts a scaled mint below one the same way", async () => {
    const rpcServer = await startTokenRpcServer(plainTransfer(MINT_SCALED), {
      mintAccountsByAddress: {
        [MINT_SCALED]: { data: scaledMintAccount(0.5), owner: TOKEN_2022_PROGRAM_ADDRESS },
      },
    });

    try {
      const [observed] = await buildObservedRows(rpcServer, [signatureEntry()]);
      expect(observed?.amount).toBe("0.5");
      expect(observed?.amount).toBe(
        amountToUiAmountForScaledUiAmountMintWithoutSimulation(RAW_AMOUNT, DECIMALS, 0.5)
      );
    } finally {
      await rpcServer.close();
    }
  });

  it("converts with the scheduled multiplier once matured and drops the pre-maturity row", async () => {
    const mintAccount = scaledMintAccount(1, { multiplier: 3, effectiveTimestamp: 1_690_000_000n });
    const rpcServer = await startTokenRpcServer(plainTransfer(MINT_SCALED), {
      mintAccountsByAddress: {
        [MINT_SCALED]: { data: mintAccount, owner: TOKEN_2022_PROGRAM_ADDRESS },
      },
    });

    try {
      const rows = await buildObservedRows(rpcServer, [
        // Confirmed after the new multiplier matured: it applies.
        signatureEntry({ signature: "sig_after_maturity" }),
        // Confirmed before it matured: whether the pending schedule (or an
        // older one since replaced) governed the confirming block cannot be
        // established from the current mint account, so the row is dropped
        // rather than confirmed with a possibly-wrong amount.
        signatureEntry({ signature: "sig_before_maturity", blockTime: 1_680_000_000n }),
      ]);

      expect(rows.map((row) => row.amount)).toEqual([
        amountToUiAmountForScaledUiAmountMintWithoutSimulation(RAW_AMOUNT, DECIMALS, 3),
      ]);
      // The shared batch-wide resolver reads the mint once for both
      // signatures instead of once per signature.
      expect(rpcServer.getAccountInfoCalls()).toEqual([MINT_SCALED]);
    } finally {
      await rpcServer.close();
    }
  });

  it("converts a transferChecked on a scaled mint even when the RPC reported a decimals-only uiAmountString", async () => {
    const rpcServer = await startTokenRpcServer(
      {
        type: "transferChecked",
        info: {
          source: SOURCE_TOKEN_ACCOUNT,
          destination: DESTINATION_TOKEN_ACCOUNT,
          mint: MINT_SCALED,
          authority: SOURCE_OWNER,
          tokenAmount: {
            amount: RAW_AMOUNT.toString(),
            decimals: DECIMALS,
            uiAmount: 1,
            uiAmountString: "1",
          },
        },
        ...transferBalances(MINT_SCALED),
      },
      {
        mintAccountsByAddress: {
          [MINT_SCALED]: { data: SCALED_MINT_ACCOUNT, owner: TOKEN_2022_PROGRAM_ADDRESS },
        },
      }
    );

    try {
      const [observed] = await buildObservedRows(rpcServer, [signatureEntry()]);
      expect(observed?.status).toBe("confirmed");
      expect(observed?.direction).toBe("inbound");
      expect(observed?.amount).toBe(
        amountToUiAmountForScaledUiAmountMintWithoutSimulation(RAW_AMOUNT, DECIMALS, 2)
      );
      expect(observed?.amount).toBe("2");
    } finally {
      await rpcServer.close();
    }
  });

  it("accrues interest on an interest-bearing mint from the historical clock", async () => {
    const rpcServer = await startTokenRpcServer(plainTransfer(MINT_INTEREST), {
      mintAccountsByAddress: {
        [MINT_INTEREST]: { data: interestMintAccount(), owner: TOKEN_2022_PROGRAM_ADDRESS },
      },
    });

    try {
      const [observed] = await buildObservedRows(rpcServer, [signatureEntry()]);
      expect(observed?.amount).toBe(
        amountToUiAmountForInterestBearingMintWithoutSimulation(
          RAW_AMOUNT,
          DECIMALS,
          BLOCK_TIME,
          1_690_000_000,
          1_660_000_000,
          500,
          500
        )
      );
      expect(observed?.amount).toBe("1.065429");
    } finally {
      await rpcServer.close();
    }
  });

  it("mints on a scaled mint report the scaled amount (mintTo resolves the mint from the balances)", async () => {
    // Real jsonParsed mintTo info is { mint, account, amount, mintAuthority };
    // this variant omits the explicit mint so the balances tie the account to
    // the mint, the fallback the builder supports.
    const rpcServer = await startTokenRpcServer(
      {
        type: "mintTo",
        info: {
          account: DESTINATION_TOKEN_ACCOUNT,
          amount: RAW_AMOUNT.toString(),
          authority: MINT_AUTHORITY,
        },
        postTokenBalances: [tokenBalance(1, MINT_SCALED, DESTINATION_OWNER, RAW_AMOUNT, "1")],
      },
      {
        mintAccountsByAddress: {
          [MINT_SCALED]: { data: SCALED_MINT_ACCOUNT, owner: TOKEN_2022_PROGRAM_ADDRESS },
        },
      }
    );

    try {
      const [observed] = await buildObservedRows(rpcServer, [signatureEntry()]);
      expect(observed?.status).toBe("confirmed");
      expect(observed?.direction).toBe("inbound");
      expect(observed?.token).toBe(MINT_SCALED);
      expect(observed?.amount).toBe(
        amountToUiAmountForScaledUiAmountMintWithoutSimulation(RAW_AMOUNT, DECIMALS, 2)
      );
      expect(observed?.amount).toBe("2");
    } finally {
      await rpcServer.close();
    }
  });

  it("mints via mintToChecked on a scaled mint report the scaled amount despite the reported uiAmountString", async () => {
    const rpcServer = await startTokenRpcServer(
      {
        type: "mintToChecked",
        info: {
          mint: MINT_SCALED,
          account: DESTINATION_TOKEN_ACCOUNT,
          mintAuthority: MINT_AUTHORITY,
          tokenAmount: {
            amount: RAW_AMOUNT.toString(),
            decimals: DECIMALS,
            uiAmount: 1,
            uiAmountString: "1",
          },
        },
        postTokenBalances: [tokenBalance(1, MINT_SCALED, DESTINATION_OWNER, RAW_AMOUNT, "1")],
      },
      {
        mintAccountsByAddress: {
          [MINT_SCALED]: { data: SCALED_MINT_ACCOUNT, owner: TOKEN_2022_PROGRAM_ADDRESS },
        },
      }
    );

    try {
      const [observed] = await buildObservedRows(rpcServer, [signatureEntry()]);
      expect(observed?.direction).toBe("inbound");
      expect(observed?.amount).toBe("2");
    } finally {
      await rpcServer.close();
    }
  });

  it("drops the observation when the mint account cannot be resolved", async () => {
    const rpcServer = await startTokenRpcServer(plainTransfer(MINT_SCALED));

    try {
      const rows = await buildObservedRows(rpcServer, [signatureEntry()]);
      expect(rows).toEqual([]);
      expect(rpcServer.getAccountInfoCalls()).toEqual([MINT_SCALED]);
    } finally {
      await rpcServer.close();
    }
  });

  it("drops the observation even behind a classic label when the mint cannot be resolved", async () => {
    // A classic "spl-token" label cannot prove the mint is legacy: a
    // Token-2022 instruction can carry one (as the owner-program conversion
    // above shows). With the mint unreadable, a decimals-only fallback could
    // confirm a wrong amount for a scaled or interest-bearing mint.
    const rpcServer = await startTokenRpcServer({
      ...plainTransfer(MINT_SCALED),
      program: "spl-token",
    });

    try {
      const rows = await buildObservedRows(rpcServer, [signatureEntry()]);
      expect(rows).toEqual([]);
    } finally {
      await rpcServer.close();
    }
  });

  it("drops the observation when the extension mint has no historical clock to convert with", async () => {
    const rpcServer = await startTokenRpcServer(
      { ...plainTransfer(MINT_SCALED), blockTime: null },
      {
        mintAccountsByAddress: {
          [MINT_SCALED]: { data: SCALED_MINT_ACCOUNT, owner: TOKEN_2022_PROGRAM_ADDRESS },
        },
      }
    );

    try {
      const rows = await buildObservedRows(rpcServer, [signatureEntry({ blockTime: null })]);
      expect(rows).toEqual([]);
    } finally {
      await rpcServer.close();
    }
  });

  it("drops the observation when an interest-bearing rate update postdates the transaction", async () => {
    const rpcServer = await startTokenRpcServer(
      { ...plainTransfer(MINT_INTEREST), blockTime: 1_680_000_000 },
      {
        mintAccountsByAddress: {
          [MINT_INTEREST]: { data: interestMintAccount(), owner: TOKEN_2022_PROGRAM_ADDRESS },
        },
      }
    );

    try {
      const rows = await buildObservedRows(rpcServer, [
        signatureEntry({ blockTime: 1_680_000_000n }),
      ]);
      expect(rows).toEqual([]);
    } finally {
      await rpcServer.close();
    }
  });

  it("converts by mint owner even when a classic label mislabels a Token-2022 instruction", async () => {
    // The jsonParsed program label is the cheap discriminator, but the mint's
    // own owner program decides: a scaled Token-2022 mint behind a classic
    // "spl-token" label must still convert extension-aware.
    const rpcServer = await startTokenRpcServer(
      { ...plainTransfer(MINT_SCALED), program: "spl-token" },
      {
        mintAccountsByAddress: {
          [MINT_SCALED]: { data: SCALED_MINT_ACCOUNT, owner: TOKEN_2022_PROGRAM_ADDRESS },
        },
      }
    );

    try {
      const [observed] = await buildObservedRows(rpcServer, [signatureEntry()]);
      expect(observed?.status).toBe("confirmed");
      expect(observed?.amount).toBe("2");
    } finally {
      await rpcServer.close();
    }
  });

  it("keeps decimals-only amounts for a static-decimal Token-2022 mint", async () => {
    const rpcServer = await startTokenRpcServer(plainTransfer(MINT_STATIC_2022), {
      mintAccountsByAddress: {
        [MINT_STATIC_2022]: { data: STATIC_2022_MINT_ACCOUNT, owner: TOKEN_2022_PROGRAM_ADDRESS },
      },
    });

    try {
      const [observed] = await buildObservedRows(rpcServer, [signatureEntry()]);
      expect(observed?.status).toBe("confirmed");
      expect(observed?.direction).toBe("inbound");
      expect(observed?.amount).toBe("1");
    } finally {
      await rpcServer.close();
    }
  });

  it("keeps decimals-only amounts for a legacy SPL token mint", async () => {
    const rpcServer = await startTokenRpcServer(
      { ...plainTransfer(MINT_CLASSIC), program: "spl-token" },
      {
        mintAccountsByAddress: {
          [MINT_CLASSIC]: { data: CLASSIC_MINT_ACCOUNT, owner: TOKEN_PROGRAM_ADDRESS },
        },
      }
    );

    try {
      const [observed] = await buildObservedRows(rpcServer, [signatureEntry()]);
      expect(observed?.status).toBe("confirmed");
      expect(observed?.direction).toBe("inbound");
      expect(observed?.token).toBe(MINT_CLASSIC);
      expect(observed?.amount).toBe("1");
    } finally {
      await rpcServer.close();
    }
  });

  it("does not resolve extension state for SOL system transfers", async () => {
    const rpcServer = await startTokenRpcServer({
      program: "system",
      type: "transfer",
      info: { source: SOURCE_OWNER, destination: DESTINATION_OWNER, lamports: "1000" },
      preTokenBalances: [],
      postTokenBalances: [],
    });

    try {
      const [observed] = await buildObservedRows(rpcServer, [signatureEntry()]);
      expect(observed?.token).toBeTypeOf("string");
      expect(rpcServer.getAccountInfoCalls()).toEqual([]);
    } finally {
      await rpcServer.close();
    }
  });
});
