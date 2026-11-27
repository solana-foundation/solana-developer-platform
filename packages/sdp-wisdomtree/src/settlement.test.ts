import { supportsProviderSettlement } from "@sdp/earn/capabilities";
import { resetWisdomTreeTokenCache } from "@sdp/earn/providers/wisdomtree/connect";
import type { EarnProviderSettlementInput, EarnRuntimeContext } from "@sdp/earn/types";
import { deriveAssociatedTokenAddress } from "@sdp/solana/address";
import { SPL_TOKEN_PROGRAMS, wellKnownMint } from "@sdp/types/well-known-tokens";
import { WISDOMTREE_FUNDS } from "@sdp/types/wisdomtree-programs";
import { getBase58Decoder } from "@solana/kit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WisdomTreeVaultDirectClient } from "./client";

const FUND = WISDOMTREE_FUNDS[0];
const OWNER = "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr";
const SOURCE = getBase58Decoder().decode(new Uint8Array(64).fill(1));
const DESTINATION = getBase58Decoder().decode(new Uint8Array(64).fill(2));
const OTHER = getBase58Decoder().decode(new Uint8Array(64).fill(3));
const ctx: EarnRuntimeContext = {
  environment: "production",
  env: {
    WISDOMTREE_API_KEY: JSON.stringify({
      clientId: "client",
      clientSecret: "secret",
      username: "user",
      password: "password",
    }),
  },
};
const deposit: EarnProviderSettlementInput = {
  providerReference: FUND.mint,
  owner: OWNER,
  sourceSignature: SOURCE,
  direction: "deposit",
};
const withdrawal: EarnProviderSettlementInput = { ...deposit, direction: "withdrawal" };
function order(direction = deposit.direction) {
  return {
    blockchain: "Solana",
    exchange_code: FUND.exchangeCode,
    token_contract_address: FUND.mint,
    settlement_wallet_address: OWNER,
    trade_type: direction === "deposit" ? "Purchase" : "Sale",
    settlement_currency: "2",
    settlement_currency_name: "USDC",
    status: "Settled",
    order_type: "Primary",
    conversion_order_hash: direction === "deposit" ? SOURCE : DESTINATION,
    deposit_hash: SOURCE,
    issuer_order_hash: direction === "deposit" ? DESTINATION : null,
    token_amount: "2.500000000",
    net_value: "2.49",
  };
}
function connect(body: Record<string, string | null> = order(), status = 200) {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname === "/o/token/")
      return Response.json({ access_token: "token", expires_in: 600 });
    expect(init?.method).toBe("GET");
    expect(url.origin).toBe("https://api.wisdomtreeconnect.com");
    expect(url.pathname).toBe(`/api/orders/hash/${SOURCE}`);
    expect([...url.searchParams]).toEqual([]);
    return Response.json(body, { status });
  });
}
function client() {
  return new WisdomTreeVaultDirectClient(
    async () => {
      throw new Error("Settlement reader must not perform RPC reads");
    },
    (_label, operation) => operation(() => undefined)
  );
}
beforeEach(() => resetWisdomTreeTokenCache());
afterEach(() => vi.restoreAllMocks());

describe("WisdomTree shared settlement capability", () => {
  it("returns a correlated purchase delivery candidate without chain or admission reads", async () => {
    const fetch = connect();
    const provider = client();
    expect(supportsProviderSettlement(provider)).toBe(true);
    expect(await provider.readProviderSettlement(ctx, deposit)).toEqual({
      sourceSignature: SOURCE,
      owner: OWNER,
      destinationSignature: DESTINATION,
      tokenMint: FUND.mint,
      programAddress: SPL_TOKEN_PROGRAMS["token-2022"],
      requiredAccount: await deriveAssociatedTokenAddress(
        OWNER,
        FUND.mint,
        SPL_TOKEN_PROGRAMS["token-2022"]
      ),
      expectedAmount: "2.5",
      phase: "processing",
    });
    await provider.readProviderSettlement(ctx, deposit);
    expect(fetch).toHaveBeenCalledTimes(3); // One token grant and one order GET per observation.
  });

  it("uses the sale conversion payout rather than the fund-token burn", async () => {
    connect({ ...order("withdrawal"), issuer_order_hash: OTHER });
    const usdc = wellKnownMint("USDC", "mainnet-beta");
    if (usdc === undefined) throw new Error("Expected mainnet USDC");
    expect(await client().readProviderSettlement(ctx, withdrawal)).toMatchObject({
      destinationSignature: DESTINATION,
      tokenMint: usdc,
      programAddress: SPL_TOKEN_PROGRAMS["spl-token"],
      requiredAccount: await deriveAssociatedTokenAddress(
        OWNER,
        usdc,
        SPL_TOKEN_PROGRAMS["spl-token"]
      ),
      expectedAmount: "2.49",
    });
  });

  it("accepts a recorded purchase deposit when its conversion hash differs", async () => {
    connect({ ...order(), conversion_order_hash: OTHER });
    expect(await client().readProviderSettlement(ctx, deposit)).toMatchObject({
      destinationSignature: DESTINATION,
    });
  });

  it.each([403, 404])("keeps an inaccessible or unrecorded order pending (%i)", async (status) => {
    connect(order(), status);
    expect(await client().readProviderSettlement(ctx, deposit)).toMatchObject({
      destinationSignature: null,
      phase: "processing",
    });
  });

  it.each([
    "Order Received",
    "Order Approved",
    "Order Valid",
    "Settling - Token Delivered",
    "Settling - Tokens Burned",
    "Settling - Conversion Token Received",
    "A future status",
  ])("keeps %s pending despite a candidate hash", async (status) => {
    connect({ ...order(), status });
    const result = await client().readProviderSettlement(ctx, deposit);
    expect(result.destinationSignature).toBeNull();
    expect(result.expectedAmount).toBeUndefined();
  });

  it.each(["Failed", "Order Failed", "Order Refunded", "Cancelled"])(
    "keeps %s in recovery without claiming payout",
    async (status) => {
      connect({ ...order(), status });
      expect(await client().readProviderSettlement(ctx, deposit)).toMatchObject({
        destinationSignature: null,
        phase: "recovery_required",
      });
    }
  );

  it.each([
    { exchange_code: "OTHER" },
    { token_contract_address: OWNER },
    { settlement_wallet_address: FUND.mint },
    { trade_type: "Sale" },
    { blockchain: "Ethereum" },
    { settlement_currency_name: "USD" },
    { order_type: "Secondary" },
    { conversion_order_hash: OTHER, deposit_hash: OTHER },
  ])("refuses mismatched order identity %j", async (mismatch) => {
    connect({ ...order(), ...mismatch });
    await expect(client().readProviderSettlement(ctx, deposit)).rejects.toMatchObject({
      code: "PROVIDER_UNAVAILABLE",
    });
  });

  it("does not confuse a matching issuer hash with an opening transfer", async () => {
    connect({
      ...order(),
      conversion_order_hash: OTHER,
      deposit_hash: OTHER,
      issuer_order_hash: SOURCE,
    });
    await expect(client().readProviderSettlement(ctx, deposit)).rejects.toMatchObject({
      code: "PROVIDER_UNAVAILABLE",
    });
  });

  it.each([null, ""])("waits for a missing issuer delivery hash %j", async (issuer_order_hash) => {
    connect({ ...order(), issuer_order_hash });
    expect(await client().readProviderSettlement(ctx, deposit)).toMatchObject({
      destinationSignature: null,
    });
  });

  it.each([SOURCE, "not-a-solana-signature"])(
    "refuses an unusable destination hash %s",
    async (issuer_order_hash) => {
      connect({ ...order(), issuer_order_hash });
      await expect(client().readProviderSettlement(ctx, deposit)).rejects.toMatchObject({
        code: "PROVIDER_UNAVAILABLE",
      });
    }
  );

  it("waits when a settled order has not reported its final share quantity", async () => {
    connect({ ...order(), token_amount: null });
    expect(await client().readProviderSettlement(ctx, deposit)).toMatchObject({
      destinationSignature: null,
    });
  });

  it.each(["0", "-1", "0.0000000001"])(
    "refuses an unusable settled share quantity %s",
    async (token_amount) => {
      connect({ ...order(), token_amount });
      await expect(client().readProviderSettlement(ctx, deposit)).rejects.toMatchObject({
        code: "PROVIDER_UNAVAILABLE",
      });
    }
  );

  it("refuses a fund on the wrong cluster before provider I/O", async () => {
    const fetch = connect();
    await expect(
      client().readProviderSettlement({ ...ctx, environment: "sandbox" }, deposit)
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(fetch).not.toHaveBeenCalled();
  });
});
