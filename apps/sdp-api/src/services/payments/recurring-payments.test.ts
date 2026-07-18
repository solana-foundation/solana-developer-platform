import { SPL_TOKEN_PROGRAMS } from "@sdp/types";
import { address, createNoopSigner } from "@solana/kit";
import { getTransferSolInstruction } from "@solana-program/system";
import {
  getCreateAssociatedTokenIdempotentInstruction,
  getSyncNativeInstruction,
} from "@solana-program/token-2022";
import { describe, expect, it } from "vitest";
import { SOL_MINT } from "@/services/payment-operation.service";
import { TEST_SOLANA_ADDRESSES } from "@/test/fixtures/tokens";
import { buildNativeSolWrapInstructions } from "./recurring-payments";

const sourceOwner = address(TEST_SOLANA_ADDRESSES.wallet1);
const sourceSigner = createNoopSigner(sourceOwner);
const payer = createNoopSigner(address(TEST_SOLANA_ADDRESSES.wallet2));
const sourceTokenAccount = address(TEST_SOLANA_ADDRESSES.wallet3);
const tokenProgram = address(SPL_TOKEN_PROGRAMS["spl-token"]);
const amountBaseUnits = 1_250_000_000n;

describe("buildNativeSolWrapInstructions", () => {
  it("wraps the exact amount into the resolved source token account", () => {
    const instructions = buildNativeSolWrapInstructions({
      payer,
      sourceSigner,
      sourceOwner,
      sourceTokenAccount: { tokenAccount: sourceTokenAccount, exists: true },
      tokenProgram,
      amountBaseUnits,
    });

    expect(instructions).toEqual([
      getTransferSolInstruction({
        source: sourceSigner,
        destination: sourceTokenAccount,
        amount: amountBaseUnits,
      }),
      getSyncNativeInstruction({ account: sourceTokenAccount }, { programAddress: tokenProgram }),
    ]);
  });

  it("creates a missing source ATA before wrapping native SOL", () => {
    const instructions = buildNativeSolWrapInstructions({
      payer,
      sourceSigner,
      sourceOwner,
      sourceTokenAccount: { tokenAccount: sourceTokenAccount, exists: false },
      tokenProgram,
      amountBaseUnits,
    });

    expect(instructions).toEqual([
      getCreateAssociatedTokenIdempotentInstruction({
        payer,
        ata: sourceTokenAccount,
        owner: sourceOwner,
        mint: address(SOL_MINT),
        tokenProgram,
      }),
      getTransferSolInstruction({
        source: sourceSigner,
        destination: sourceTokenAccount,
        amount: amountBaseUnits,
      }),
      getSyncNativeInstruction({ account: sourceTokenAccount }, { programAddress: tokenProgram }),
    ]);
  });
});
