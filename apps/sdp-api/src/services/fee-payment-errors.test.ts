import { FeePaymentError } from "@sdp/fee-payment/port";
import {
  AccountRole,
  createNoopSigner,
  generateKeyPairSigner,
  type Instruction,
} from "@solana/kit";
import { getTransferSolInstruction } from "@solana-program/system";
import {
  getTransferCheckedInstruction,
  TOKEN_2022_PROGRAM_ADDRESS,
} from "@solana-program/token-2022";
import { describe, expect, it } from "vitest";
import {
  callerInsufficientFundsError,
  INSUFFICIENT_FUNDS_MESSAGE,
  simulatedInsufficientFundsError,
} from "@/services/fee-payment-errors";

const koraShortfall = (instructionIndex: number) =>
  new FeePaymentError(
    `Failed to sign transaction as fee payer: Kora Error -32000: Invalid transaction: Transaction simulation failed: Error processing Instruction ${instructionIndex}: custom program error: 0x1`,
    "PROVIDER_REJECTED"
  );

async function token2022Transfer(): Promise<Instruction> {
  const [authority, source, mint, destination] = await Promise.all(
    Array.from({ length: 4 }, () => generateKeyPairSigner())
  );
  return getTransferCheckedInstruction(
    {
      source: source.address,
      mint: mint.address,
      destination: destination.address,
      authority: createNoopSigner(authority.address),
      amount: 1n,
      decimals: 6,
    },
    { programAddress: TOKEN_2022_PROGRAM_ADDRESS }
  );
}

async function withHookAccount(instruction: Instruction): Promise<Instruction> {
  const hookProgram = await generateKeyPairSigner();
  return {
    ...instruction,
    accounts: [
      ...(instruction.accounts ?? []),
      { address: hookProgram.address, role: AccountRole.READONLY },
    ],
  };
}

describe("callerInsufficientFundsError (HOO-2621)", () => {
  it("names the source wallet for 0x1 on a Token-2022 transfer with no hook accounts", async () => {
    const transfer = await token2022Transfer();

    const error = callerInsufficientFundsError(koraShortfall(0), [transfer]);

    expect(error).toMatchObject({
      code: "TRANSACTION_FAILED",
      message: INSUFFICIENT_FUNDS_MESSAGE,
    });
  });

  it("does not blame the wallet for 0x1 on a transfer that runs a hook", async () => {
    const hooked = await withHookAccount(await token2022Transfer());

    expect(callerInsufficientFundsError(koraShortfall(0), [hooked])).toBeNull();
    expect(
      simulatedInsufficientFundsError(
        JSON.stringify({ InstructionError: ["0", { Custom: "1" }] }),
        [hooked]
      )
    ).toBeNull();
  });

  it("does not blame the wallet for 0x1 on another instruction than the transfer", async () => {
    const source = await generateKeyPairSigner();
    const destination = await generateKeyPairSigner();
    const transfer = getTransferSolInstruction({
      source: createNoopSigner(source.address),
      destination: destination.address,
      amount: 1n,
    });

    expect(callerInsufficientFundsError(koraShortfall(1), [transfer])).toBeNull();
    expect(callerInsufficientFundsError(koraShortfall(0), [transfer])).not.toBeNull();
  });
});
