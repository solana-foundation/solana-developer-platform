import { FeePaymentError } from "@sdp/fee-payment/port";
import type { Instruction } from "@solana/kit";
import { SYSTEM_PROGRAM_ADDRESS } from "@solana-program/system";
import { TOKEN_PROGRAM_ADDRESS } from "@solana-program/token";
import { TOKEN_2022_PROGRAM_ADDRESS } from "@solana-program/token-2022";
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

/** SystemInstruction::Transfer, a u32 little-endian discriminator. */
const SYSTEM_TRANSFER = 2;
/** TokenInstruction::Transfer and TransferChecked, shared by SPL Token and Token-2022. */
const TOKEN_TRANSFER = 3;
const TOKEN_TRANSFER_CHECKED = 12;

/**
 * Whether `instruction` moves value out of a wallet it names as the source:
 * a System Program transfer or an SPL Token / Token-2022 transfer. For these,
 * custom error 0x1 is the source's own shortfall (System
 * `ResultWithNegativeLamports`, Token `InsufficientFunds`). The same code from
 * any other instruction, such as a destination token account the sponsor pays
 * rent for, is not the caller's.
 */
function isSourceFundedTransfer(instruction: Instruction): boolean {
  const data = instruction.data;
  if (data === undefined || data.length === 0) return false;
  if (instruction.programAddress === SYSTEM_PROGRAM_ADDRESS) {
    return (
      data.length >= 4 &&
      data[0] === SYSTEM_TRANSFER &&
      data[1] === 0 &&
      data[2] === 0 &&
      data[3] === 0
    );
  }
  if (
    instruction.programAddress === TOKEN_PROGRAM_ADDRESS ||
    instruction.programAddress === TOKEN_2022_PROGRAM_ADDRESS
  ) {
    return data[0] === TOKEN_TRANSFER || data[0] === TOKEN_TRANSFER_CHECKED;
  }
  return false;
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
  let parsed: unknown;
  try {
    parsed = JSON.parse(simulationError);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || !("InstructionError" in parsed)) {
    return null;
  }
  const [index, detail] = Array.isArray(parsed.InstructionError) ? parsed.InstructionError : [];
  const custom =
    typeof detail === "object" && detail !== null && "Custom" in detail ? detail.Custom : undefined;
  if (typeof index !== "number" || typeof custom !== "number") return null;
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
