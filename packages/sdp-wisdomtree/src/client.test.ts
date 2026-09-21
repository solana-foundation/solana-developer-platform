import {
  supportsDepositEligibility,
  supportsVaultDirect,
  supportsVaultProviderOrderWithdraw,
  supportsVaultWithdraw,
} from "@sdp/earn/capabilities";
import { SdpEarnError } from "@sdp/earn/errors";
import { resetWisdomTreeTokenCache } from "@sdp/earn/providers/wisdomtree/connect";
import type { EarnRuntimeContext } from "@sdp/earn/types";
import { SPL_TOKEN_PROGRAMS, wellKnownMint } from "@sdp/types";
import {
  WISDOMTREE_FUNDS,
  WISDOMTREE_TRANSFER_HOOK_PROGRAM_IDS,
} from "@sdp/types/wisdomtree-programs";
import { address } from "@solana/kit";
import { findAssociatedTokenPda } from "@solana-program/token-2022";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WisdomTreeChainReader } from "./chain";
import { assertWisdomTreeNotPortfolioProvider, WisdomTreeVaultDirectClient } from "./client";
import {
  extraAccountMetaListAccount,
  fakeReader,
  literalHookEntry,
  tokenAccountData,
  wtgxxMintAccountData,
} from "./fixtures.test-helper";
import { deriveExtraAccountMetasAddress } from "./transfer-hook";

const WTGXX = WISDOMTREE_FUNDS[0];
const USDC = wellKnownMint("USDC", "mainnet-beta") as string;
const TOKEN_2022 = SPL_TOKEN_PROGRAMS["token-2022"];

const OWNER = "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr";
const ON_RECEIPT = "ComputeBudget111111111111111111111111111111";

const credential = JSON.stringify({
  clientId: "client-id",
  clientSecret: "client-secret",
  username: "api-user",
  password: "api-pass",
});
const productionCtx: EarnRuntimeContext = {
  env: { WISDOMTREE_API_KEY: credential },
  environment: "production",
};

/** Offline client: proven-RPC resolver and deadline runner are passthroughs. */
function offlineClient(reader: WisdomTreeChainReader) {
  return new WisdomTreeVaultDirectClient(
    async () => "http://offline.invalid",
    (_label, operation) => operation(() => {}),
    () => reader
  );
}

/** Stub the Connect API: OAuth token, then the on-receipt Purchase wallet. */
function stubConnectFetch() {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url = String(input);
    if (url.endsWith("/o/token/")) {
      return new Response(JSON.stringify({ access_token: "bearer", expires_in: 600 }), {
        status: 200,
      });
    }
    if (url.includes("/api/orders/on-receipt-wallet/")) {
      return new Response(JSON.stringify({ wallet_address: ON_RECEIPT }), { status: 200 });
    }
    throw new Error(`Unexpected fetch in offline test: ${url}`);
  });
}

beforeEach(() => resetWisdomTreeTokenCache());
afterEach(() => vi.restoreAllMocks());

describe("capability shape", () => {
  it("is vault-direct with eligibility AND withdraw, and never custodial", () => {
    const client = offlineClient(fakeReader({}));
    expect(supportsVaultDirect(client)).toBe(true);
    expect(supportsVaultWithdraw(client)).toBe(true);
    expect(supportsVaultProviderOrderWithdraw(client)).toBe(true);
    expect(supportsDepositEligibility(client)).toBe(true);
    expect(() => assertWisdomTreeNotPortfolioProvider(client)).not.toThrow();
  });

  it("declares the same programs the output guard enforces", () => {
    const client = offlineClient(fakeReader({}));
    const mainnet = client.sponsoredPrograms("mainnet-beta");
    expect(mainnet).toContain("F4wFSShcdmaHWGRRXhCHinNTt8spgdh26Wi8hbN2Rzbh");
    // Devnet declares no WisdomTree-specific program — nothing is deployed there.
    expect(client.sponsoredPrograms("devnet")).not.toContain(
      "F4wFSShcdmaHWGRRXhCHinNTt8spgdh26Wi8hbN2Rzbh"
    );
  });
});

describe("buildVaultDeposit", () => {
  it("refuses minSharesOut as a caller error, before any network or chain read", async () => {
    const reader = fakeReader({});
    const fetchSpy = stubConnectFetch();
    const client = offlineClient(reader);
    await expect(
      client.buildVaultDeposit(productionCtx, {
        providerReference: WTGXX.mint,
        owner: OWNER,
        amount: "10",
        minSharesOut: "9.9",
      })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(reader.reads).toEqual([]);
  });

  it("refuses a reference outside the fund registry", async () => {
    stubConnectFetch();
    const client = offlineClient(fakeReader({}));
    await expect(
      client.buildVaultDeposit(productionCtx, {
        providerReference: USDC,
        owner: OWNER,
        amount: "10",
      })
    ).rejects.toThrowError(SdpEarnError);
  });

  it("builds the subscription transfer against the API-resolved on-receipt wallet", async () => {
    const fetchSpy = stubConnectFetch();
    const [onReceiptUsdcAta] = await findAssociatedTokenPda({
      owner: address(ON_RECEIPT),
      mint: address(USDC),
      tokenProgram: address(SPL_TOKEN_PROGRAMS["spl-token"]),
    });
    const reader = fakeReader({
      [WTGXX.mint]: { owner: TOKEN_2022, data: wtgxxMintAccountData() },
      [String(onReceiptUsdcAta)]: { data: tokenAccountData(0n) },
    });
    const client = offlineClient(reader);

    const plan = await client.buildVaultDeposit(productionCtx, {
      providerReference: WTGXX.mint,
      owner: OWNER,
      amount: "100.25",
    });

    expect(plan.cluster).toBe("mainnet-beta");
    expect(plan.assetIdentity).toEqual({ depositTokenMint: USDC, shareMint: WTGXX.mint });
    expect(plan.accepted).toEqual({ amount: "100.25" });
    expect(plan.createsShareAccount).toBe(true);
    expect(plan.lookupTables).toEqual([]);
    // Wire shape: plain JSON, base64 data, numeric roles.
    for (const instruction of plan.instructions) {
      expect(typeof instruction.data).toBe("string");
      for (const account of instruction.accounts) {
        expect(typeof account.role).toBe("number");
      }
    }

    // The settlement wallet came from Connect, not configuration: the wallet
    // read carried the full Purchase selector, and the transfer's destination
    // is that wallet's own USDC ATA.
    const walletCall = fetchSpy.mock.calls
      .map((call) => String(call[0]))
      .find((url) => url.includes("/api/orders/on-receipt-wallet/"));
    expect(walletCall).toBeDefined();
    const params = new URL(walletCall ?? "https://sdp.invalid").searchParams;
    expect(params.get("trade_type")).toBe("Purchase");
    expect(params.get("fund")).toBe(WTGXX.exchangeCode);
    expect(params.get("currency")).toBe("USDC");
    expect(params.get("blockchain")).toBe("Solana");
    const transfer = plan.instructions.at(-1);
    expect((transfer?.accounts ?? []).map((account) => String(account.address))).toContain(
      String(onReceiptUsdcAta)
    );
  });

  it("maps a sub-atomic amount onto the caller-fault taxonomy", async () => {
    stubConnectFetch();
    const reader = fakeReader({
      [WTGXX.mint]: { owner: TOKEN_2022, data: wtgxxMintAccountData() },
    });
    const client = offlineClient(reader);
    await expect(
      client.buildVaultDeposit(productionCtx, {
        providerReference: WTGXX.mint,
        owner: OWNER,
        amount: "1.0000001",
      })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });
});

describe("buildVaultWithdrawal", () => {
  it("refuses minAmountOut as a caller error, before any network or chain read", async () => {
    const reader = fakeReader({});
    const fetchSpy = stubConnectFetch();
    const resolveRpcUrl = vi.fn(async () => "http://offline.invalid");
    const client = new WisdomTreeVaultDirectClient(
      resolveRpcUrl,
      (_label, operation) => operation(() => {}),
      () => reader
    );

    await expect(
      client.buildVaultWithdrawal(productionCtx, {
        providerReference: WTGXX.mint,
        owner: OWNER,
        shares: "10",
        minAmountOut: "9.9",
      })
    ).rejects.toMatchObject({
      code: "BAD_REQUEST",
      message: expect.stringContaining("minAmountOut cannot be enforced"),
    });
    expect(resolveRpcUrl).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(reader.reads).toEqual([]);
  });

  it("builds the redemption transfer against the API-resolved Sale wallet", async () => {
    const fetchSpy = stubConnectFetch();
    const [onReceiptFundAta] = await findAssociatedTokenPda({
      owner: address(ON_RECEIPT),
      mint: address(WTGXX.mint),
      tokenProgram: address(TOKEN_2022),
    });
    const reader = fakeReader({
      [WTGXX.mint]: { owner: TOKEN_2022, data: wtgxxMintAccountData() },
      // The Sale wallet's fund ATA exists, so the plan is the bare transfer.
      [String(onReceiptFundAta)]: { owner: TOKEN_2022, data: tokenAccountData(0n) },
      // Hook resolution needs the live ExtraAccountMetaList: one literal extra.
      [String(
        await deriveExtraAccountMetasAddress(
          address(WISDOMTREE_TRANSFER_HOOK_PROGRAM_IDS["mainnet-beta"] as string),
          address(WTGXX.mint)
        )
      )]: {
        owner: WISDOMTREE_TRANSFER_HOOK_PROGRAM_IDS["mainnet-beta"] as string,
        data: extraAccountMetaListAccount([literalHookEntry(USDC)]),
      },
    });
    const client = offlineClient(reader);

    const plan = await client.buildVaultWithdrawal(productionCtx, {
      providerReference: WTGXX.mint,
      owner: OWNER,
      shares: "12.5",
    });

    // The on-receipt read carried the full Sale selector: this is the
    // redemption lane, for this fund, priced in USDC, on Solana.
    const walletCall = fetchSpy.mock.calls
      .map((call) => String(call[0]))
      .find((url) => url.includes("/api/orders/on-receipt-wallet/"));
    expect(walletCall).toBeDefined();
    const params = new URL(walletCall ?? "https://sdp.invalid").searchParams;
    expect(params.get("trade_type")).toBe("Sale");
    expect(params.get("fund")).toBe(WTGXX.exchangeCode);
    expect(params.get("currency")).toBe("USDC");
    expect(params.get("blockchain")).toBe("Solana");

    expect(plan.cluster).toBe("mainnet-beta");
    expect(plan.accepted).toEqual({ shares: "12.5" });
    expect(plan.assetIdentity).toEqual({ depositTokenMint: USDC, shareMint: WTGXX.mint });
    expect(plan.createsShareAccount).toBeUndefined();
    // The transfer's destination is the Sale wallet's OWN fund ATA — the
    // address Connect resolved, not a configuration constant.
    const transfer = plan.instructions.at(-1);
    expect(String(transfer?.programAddress)).toBe(TOKEN_2022);
    expect((transfer?.accounts ?? []).map((account) => String(account.address))).toContain(
      String(onReceiptFundAta)
    );
  });

  it("maps a sub-atomic share quantity onto the caller-fault taxonomy", async () => {
    stubConnectFetch();
    const reader = fakeReader({
      [WTGXX.mint]: { owner: TOKEN_2022, data: wtgxxMintAccountData() },
    });
    const client = offlineClient(reader);
    await expect(
      client.buildVaultWithdrawal(productionCtx, {
        providerReference: WTGXX.mint,
        owner: OWNER,
        shares: "1.0000000001",
      })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });
});

describe("readVaultPositions", () => {
  it("answers an empty page on devnet, where no instrument exists", async () => {
    const client = offlineClient(fakeReader({}));
    const positions = await client.readVaultPositions(
      { env: {}, environment: "sandbox" },
      { owner: OWNER, providerReferences: [] }
    );
    expect(positions).toEqual([]);
  });

  it("reports exact balances and drops empty holdings only on discovery", async () => {
    const [ownerFundAta] = await findAssociatedTokenPda({
      owner: address(OWNER),
      mint: address(WTGXX.mint),
      tokenProgram: address(TOKEN_2022),
    });
    const holding = fakeReader({
      [String(ownerFundAta)]: { owner: TOKEN_2022, data: tokenAccountData(37_969_751_026n) },
    });
    const client = offlineClient(holding);

    const discovered = await client.readVaultPositions(productionCtx, {
      owner: OWNER,
      providerReferences: [],
    });
    expect(discovered).toEqual([
      {
        providerReference: WTGXX.mint,
        owner: OWNER,
        cluster: "mainnet-beta",
        shares: "37.969751026",
        withdrawableShares: "37.969751026",
        tokenMint: USDC,
        shareMint: WTGXX.mint,
      },
    ]);

    // An explicitly requested fund may truthfully answer zero.
    const emptyClient = offlineClient(fakeReader({}));
    const explicit = await emptyClient.readVaultPositions(productionCtx, {
      owner: OWNER,
      providerReferences: [WTGXX.mint],
    });
    expect(explicit).toHaveLength(1);
    expect(explicit[0].shares).toBe("0");

    const discoveredEmpty = await emptyClient.readVaultPositions(productionCtx, {
      owner: OWNER,
      providerReferences: [],
    });
    expect(discoveredEmpty).toEqual([]);
  });
});
