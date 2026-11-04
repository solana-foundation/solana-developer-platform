import { FeePaymentError } from "@sdp/fee-payment/port";
import type {
  AccountMeta,
  Instruction,
  InstructionWithAccounts,
  InstructionWithData,
  ReadonlyUint8Array,
} from "@solana/kit";
import {
  identifySubscriptionsInstruction,
  parseTransferFixedInstruction,
  parseTransferRecurringInstruction,
  parseTransferSubscriptionInstruction,
  SUBSCRIPTIONS_PROGRAM_ADDRESS,
  SubscriptionsInstruction,
} from "@solana/subscriptions";
import {
  identifySystemInstruction,
  parseTransferSolInstruction,
  SYSTEM_PROGRAM_ADDRESS,
  SystemInstruction,
} from "@solana-program/system";
import {
  identifyTokenInstruction,
  parseTransferCheckedInstruction,
  parseTransferInstruction,
  TOKEN_PROGRAM_ADDRESS,
  TokenInstruction,
} from "@solana-program/token";
import {
  identifyToken2022Instruction,
  parseTransferCheckedInstruction as parseToken2022TransferCheckedInstruction,
  parseTransferInstruction as parseToken2022TransferInstruction,
  TOKEN_2022_PROGRAM_ADDRESS,
  Token2022Instruction,
} from "@solana-program/token-2022";
import { z } from "zod";
import { AppError } from "@/lib/errors";

/** What a caller is told when their own wallet cannot cover the amount it sends. */
export const INSUFFICIENT_FUNDS_MESSAGE =
  "The wallet used for this payment does not have enough funds. Add funds and try again.";

const SIMULATED_PROGRAM_ERROR =
  /(?:Error processing Instruction (\d+): )?custom program error: (0x[0-9a-f]+)/i;

/**
 * The program error a sponsor's simulation of the transaction reported, as the
 * hex code Kora relays from the JSON-RPC preflight response.
 *
 * @param message - The fee payment error message.
 * @returns The failing instruction index (null when the message names none) and the lowercase hex code, or null.
 */
function simulatedProgramError(
  message: string
): { instructionIndex: number | null; code: string } | null {
  const match = SIMULATED_PROGRAM_ERROR.exec(message);
  if (!match) return null;
  return {
    instructionIndex: match[1] === undefined ? null : Number(match[1]),
    code: match[2].toLowerCase(),
  };
}

type ParsableInstruction = Instruction &
  InstructionWithAccounts<readonly AccountMeta[]> &
  InstructionWithData<ReadonlyUint8Array>;

function declaredCount(parsed: { accounts: object }): number {
  return Object.keys(parsed.accounts).length;
}

/**
 * How many accounts an instruction that spends from a source it names
 * declares, or null for any other instruction.
 */
function sourceTransferAccountCount(instruction: ParsableInstruction): number | null {
  const { data, programAddress } = instruction;
  if (data.length === 0) return null;
  if (programAddress === SYSTEM_PROGRAM_ADDRESS) {
    return identifySystemInstruction(data) === SystemInstruction.TransferSol
      ? declaredCount(parseTransferSolInstruction(instruction))
      : null;
  }
  if (programAddress === TOKEN_PROGRAM_ADDRESS) {
    switch (identifyTokenInstruction(data)) {
      case TokenInstruction.Transfer:
        return declaredCount(parseTransferInstruction(instruction));
      case TokenInstruction.TransferChecked:
        return declaredCount(parseTransferCheckedInstruction(instruction));
      default:
        return null;
    }
  }
  if (programAddress === TOKEN_2022_PROGRAM_ADDRESS) {
    switch (identifyToken2022Instruction(data)) {
      case Token2022Instruction.Transfer:
        return declaredCount(parseToken2022TransferInstruction(instruction));
      case Token2022Instruction.TransferChecked:
        return declaredCount(parseToken2022TransferCheckedInstruction(instruction));
      default:
        return null;
    }
  }
  if (programAddress === SUBSCRIPTIONS_PROGRAM_ADDRESS) {
    // A delegated pull: the program's own errors start at 100, so a custom
    // 0x1 here comes from the token transfer it makes from the delegator.
    switch (identifySubscriptionsInstruction(data)) {
      case SubscriptionsInstruction.TransferFixed:
        return declaredCount(parseTransferFixedInstruction(instruction));
      case SubscriptionsInstruction.TransferRecurring:
        return declaredCount(parseTransferRecurringInstruction(instruction));
      case SubscriptionsInstruction.TransferSubscription:
        return declaredCount(parseTransferSubscriptionInstruction(instruction));
      default:
        return null;
    }
  }
  return null;
}

/**
 * Whether `instruction` moves value out of a wallet it names as the source
 * (a System Program transfer, an SPL Token / Token-2022 transfer, or a
 * subscriptions-program pull) with no transfer-hook accounts. For these,
 * custom error 0x1 is the source's own shortfall (System
 * `ResultWithNegativeLamports`, Token `InsufficientFunds`). The same code from
 * any other instruction, such as a destination token account the sponsor pays
 * rent for, or from a Token-2022 transfer hook, is not provably the caller's:
 * a hook runs only when the transfer carries its extra accounts, so the
 * instruction must carry exactly the accounts its parser declares.
 */
function isSourceFundedTransfer(instruction: Instruction): boolean {
  const { accounts, data } = instruction;
  if (accounts === undefined || data === undefined) return false;
  // The identify and parse helpers throw on data they do not recognize.
  try {
    const declared = sourceTransferAccountCount({ ...instruction, accounts, data });
    return declared !== null && accounts.length === declared;
  } catch {
    return false;
  }
}

/** Custom error 0x1 on a source-funded transfer: the sending wallet is short. */
function isSourceShortfall(
  instructionIndex: number,
  customCode: number,
  instructions: readonly Instruction[]
): boolean {
  const instruction = instructions[instructionIndex];
  return customCode === 1 && instruction !== undefined && isSourceFundedTransfer(instruction);
}

function insufficientFunds(cause: unknown): AppError {
  return new AppError("TRANSACTION_FAILED", INSUFFICIENT_FUNDS_MESSAGE, undefined, { cause });
}

/**
 * The caller-facing error for a sponsor refusal that proves the sending
 * wallet is short of funds: the sponsor's simulation failed a transfer
 * instruction of `instructions` with custom error 0x1. Anything else (another
 * code, another instruction, a message that names no instruction) returns
 * null and keeps its upstream mapping.
 *
 * @param error - The error the sponsored submission threw.
 * @param instructions - The transaction's instructions, in order.
 * @returns A 400 `TRANSACTION_FAILED` with a tenant-safe message, or null.
 */
export function callerInsufficientFundsError(
  error: unknown,
  instructions: readonly Instruction[]
): AppError | null {
  if (!(error instanceof FeePaymentError)) return null;
  const simulated = simulatedProgramError(error.message);
  if (simulated === null || simulated.instructionIndex === null) return null;
  return isSourceShortfall(
    simulated.instructionIndex,
    Number.parseInt(simulated.code, 16),
    instructions
  )
    ? insufficientFunds(error)
    : null;
}

/** A `TransactionError` naming an instruction that failed with a custom program error. */
/**
 * `simulateTransaction` serializes the RPC's bigints as decimal strings, so
 * `[0n, { Custom: 1n }]` arrives as `["0", { "Custom": "1" }]`; accept either form.
 */
const integerSchema = z
  .union([z.number().int().nonnegative(), z.string().regex(/^\d+$/)])
  .transform(Number);
const simulatedCustomInstructionErrorSchema = z.object({
  InstructionError: z.tuple([integerSchema, z.object({ Custom: integerSchema })]),
});

/**
 * The same verdict from SDP's own preflight simulation, whose error is the
 * JSON-serialized `TransactionError`, e.g. `{"InstructionError":[1,{"Custom":1}]}`.
 *
 * @param simulationError - `SimulationResult.error` from `simulateTransaction`.
 * @param instructions - The simulated transaction's instructions, in order.
 * @returns A 400 `TRANSACTION_FAILED` with a tenant-safe message, or null.
 */
export function simulatedInsufficientFundsError(
  simulationError: string | null,
  instructions: readonly Instruction[]
): AppError | null {
  if (simulationError === null) return null;
  let json: unknown;
  try {
    json = JSON.parse(simulationError);
  } catch {
    return null;
  }
  const parsed = simulatedCustomInstructionErrorSchema.safeParse(json);
  if (!parsed.success) return null;
  const [index, { Custom: custom }] = parsed.data.InstructionError;
  return isSourceShortfall(index, custom, instructions) ? insufficientFunds(simulationError) : null;
}

/**
 * Maps a fee payment port failure to the public error contract.
 *
 * These come from the transaction fee sponsor (Kora), never from the custody
 * signer, so the copy names the sponsor: telling a caller their signing
 * provider is down sends them to check custody when custody is fine. Codes and
 * statuses are unchanged; clients branch on those.
 */
export function mapFeePaymentError(err: FeePaymentError): {
  status: 400 | 422 | 429 | 502 | 503;
  code: string;
  message: string;
} {
  const programError = simulatedProgramError(err.message)?.code;
  if (programError === "0x1") {
    return { status: 400, code: "TRANSACTION_FAILED", message: INSUFFICIENT_FUNDS_MESSAGE };
  }
  if (programError) {
    return {
      status: 400,
      code: "TRANSACTION_FAILED",
      message: "The transaction was rejected on Solana. Check the payment wallet and try again.",
    };
  }

  switch (err.code) {
    case "INSUFFICIENT_BALANCE":
      return { status: 400, code: "TRANSACTION_FAILED", message: INSUFFICIENT_FUNDS_MESSAGE };
    case "RATE_LIMITED":
      return {
        status: 429,
        code: err.code,
        message: "The transaction fee sponsor is busy. Try again.",
      };
    case "PROVIDER_REJECTED":
      // The provider returned a structured refusal of these exact bytes
      // (policy, allowlist, malformed request). Nothing was signed and a
      // retry cannot succeed, so do not tell the caller to try again.
      // SIGNING_FAILED stays on the ambiguous 502 path below: Kora answers it
      // for a malformed JSON-RPC request, which says nothing about these bytes.
      return {
        status: 422,
        code: "SIGNING_REJECTED",
        message:
          "The transaction fee sponsor rejected this transaction. Retrying will not help; check the transaction and sponsorship policy.",
      };
    case "PROVIDER_NOT_AVAILABLE":
    case "NETWORK_ERROR":
      return {
        status: 503,
        code: "PROVIDER_UNAVAILABLE",
        message: "Transaction fees can't be sponsored right now. Try again.",
      };
    default:
      return {
        status: 502,
        code: "TRANSACTION_FAILED",
        message: "The transaction could not be signed or submitted. Try again.",
      };
  }
}
