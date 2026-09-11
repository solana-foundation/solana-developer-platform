import { getAssociatedTokenAddress, getSplAssetVaultAddress } from "@heliuslabs/zolana/addresses";
import { ASSOCIATED_TOKEN_PROGRAM_ID, SPL_TOKEN_PROGRAM_ID } from "@heliuslabs/zolana/interface";
import { address } from "@solana/kit";
import { describe, expect, it } from "vitest";
import { PROTOCOL_NATIVE_MINT, SDP_NATIVE_MINT, SDP_USDC_MINT } from "./mint.js";
import { resolveWithdrawalSettlement } from "./settlement.js";

const PAYER = address("GsbwXfJraMomNxBcjK1DiP5Mth8ZmQpDUFTmKfhtiHgo");
const RECIPIENT = address("6Ecs4vFmtiZ7WeQMWZibhFPQF3q3Pmqrb7CQGRJJKQTM");
const USDC = address(SDP_USDC_MINT);

describe("resolveWithdrawalSettlement", () => {
  it.each([
    ["the protocol's native mint", PROTOCOL_NATIVE_MINT],
    // The builders resolve the asset through `protocolMint` first, so SDP's
    // wrapped-SOL spelling should never reach here — assert the native branch
    // anyway rather than let a stray SDP mint fall into the SPL path.
    ["SDP's wrapped SOL mint", SDP_NATIVE_MINT],
  ])("settles %s through the pool's native interface", async (_label, mint) => {
    const settlement = await resolveWithdrawalSettlement({
      payer: PAYER,
      recipient: RECIPIENT,
      asset: address(mint),
    });

    expect(settlement.target).toEqual({ kind: "sol", recipient: RECIPIENT });
    // One value for both roles: the proof target and the instruction's
    // account list are the same shape for SOL.
    expect(settlement.accounts).toBe(settlement.target);
    expect(settlement.setup).toEqual([]);
  });

  it("settles USDC through its vault and the recipient's associated token account", async () => {
    const [expectedAta, expectedVault] = await Promise.all([
      getAssociatedTokenAddress(RECIPIENT, USDC, SPL_TOKEN_PROGRAM_ID),
      getSplAssetVaultAddress(USDC),
    ]);

    const settlement = await resolveWithdrawalSettlement({
      payer: PAYER,
      recipient: RECIPIENT,
      asset: USDC,
    });

    expect(settlement.target).toEqual({
      kind: "spl",
      recipientTokenAccount: expectedAta,
      splTokenInterface: expectedVault,
      splInterfaceBump: expect.any(Number),
    });
    expect(settlement.accounts).toEqual({
      kind: "spl",
      mint: USDC,
      splTokenInterface: expectedVault,
      recipientTokenAccount: expectedAta,
      tokenProgram: SPL_TOKEN_PROGRAM_ID,
    });
  });

  it("recovers the vault bump the pool derives", async () => {
    const { target } = await resolveWithdrawalSettlement({
      payer: PAYER,
      recipient: RECIPIENT,
      asset: USDC,
    });

    // Not a fixed expectation: the bump is whatever the canonical derivation
    // yields. What matters is that it is a real bump seed and that the
    // resolver's own equality check against the SDK's address passed.
    expect(target.kind).toBe("spl");
    if (target.kind !== "spl") return;
    expect(target.splInterfaceBump).toBeGreaterThanOrEqual(0);
    expect(target.splInterfaceBump).toBeLessThanOrEqual(255);
  });

  it("prepends one idempotent create for the recipient's token account", async () => {
    const { setup } = await resolveWithdrawalSettlement({
      payer: PAYER,
      recipient: RECIPIENT,
      asset: USDC,
    });
    const expectedAta = await getAssociatedTokenAddress(RECIPIENT, USDC, SPL_TOKEN_PROGRAM_ID);

    expect(setup).toHaveLength(1);
    const create = setup[0];
    expect(create?.programAddress).toBe(ASSOCIATED_TOKEN_PROGRAM_ID);
    // Discriminator 1 is `createIdempotent`; 0 would fail on an account the
    // recipient already holds.
    expect(create?.data).toEqual(Uint8Array.of(1));
    expect(create?.accounts?.map((account) => account.address)).toEqual([
      PAYER,
      expectedAta,
      RECIPIENT,
      USDC,
      "11111111111111111111111111111111",
      SPL_TOKEN_PROGRAM_ID,
    ]);
  });
});
