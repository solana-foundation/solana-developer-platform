/**
 * Translate a Solana `TransactionError` from vault simulation into a sentence a
 * dashboard user can act on.
 *
 * The chain answers preflight with bare variants (`"AccountNotFound"`,
 * `{ InstructionError: [1, { Custom: 6001 }] }`) that surface verbatim in the
 * deposit/withdraw modal, where "AccountNotFound" reads as a mystery rather
 * than "your wallet has no SOL". The raw variant is kept in parentheses so
 * operators and logs searches still see the real value.
 *
 * Wording depends on who pays the fee: the fee-payer failures name the
 * customer's wallet under `wallet-pays` and SDP's sponsor under `sponsored`,
 * because telling a customer to fund their wallet when SDP's sponsor is broke
 * sends them fixing the wrong thing.
 */

import type { VaultFeeMode } from "./vault-sponsorship";

function stringifyRaw(err: unknown): string {
  try {
    return JSON.stringify(err, (_key, value) =>
      typeof value === "bigint" ? value.toString() : value
    );
  } catch {
    return String(err);
  }
}

/** "WouldExceedMaxAccountCostLimit" -> "would exceed max account cost limit" */
function humanizeVariantName(name: string): string {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .toLowerCase();
}

function feePayerNoun(fee: Pick<VaultFeeMode, "kind">): string {
  return fee.kind === "sponsored" ? "SDP's fee sponsor" : "the wallet";
}

const INSTRUCTION_ERROR_DETAILS: Record<string, string> = {
  InsufficientFunds: "an account did not hold enough funds",
  UninitializedAccount: "an account it needs has not been initialized",
  AccountNotRentExempt: "an account would be left below the rent-exempt minimum",
  InvalidAccountData: "an account held data the program did not expect",
  MissingRequiredSignature: "a required signature was missing",
};

function describeInstructionErrorDetail(detail: unknown): string {
  if (typeof detail === "string") {
    return INSTRUCTION_ERROR_DETAILS[detail] ?? `it failed with ${humanizeVariantName(detail)}`;
  }
  if (detail !== null && typeof detail === "object") {
    const custom = (detail as Record<string, unknown>).Custom;
    if (typeof custom === "number" || typeof custom === "bigint") {
      return `the program rejected it with error code ${custom}`;
    }
    const borsh = (detail as Record<string, unknown>).BorshIoError;
    if (typeof borsh === "string") {
      return `the program could not decode its input (${borsh})`;
    }
  }
  return `it failed with ${stringifyRaw(detail)}`;
}

/**
 * One readable line for the simulation verdict, raw variant appended.
 * Unrecognized variants fall back to the raw JSON so nothing is hidden.
 */
export function describeVaultSimulationError(
  err: unknown,
  fee: Pick<VaultFeeMode, "kind">
): string {
  const raw = stringifyRaw(err);

  if (typeof err === "string") {
    switch (err) {
      case "AccountNotFound":
        return fee.kind === "sponsored"
          ? `${feePayerNoun(fee)} account does not exist on this cluster, so it cannot pay the network fee. This is an SDP configuration problem, not a problem with the wallet (${err})`
          : `${feePayerNoun(fee)} holds no SOL, so it cannot pay the network fee. Send SOL to the wallet and retry (${err})`;
      case "InsufficientFundsForFee":
        return fee.kind === "sponsored"
          ? `${feePayerNoun(fee)} does not hold enough SOL to pay the network fee. This is an SDP configuration problem, not a problem with the wallet (${err})`
          : `${feePayerNoun(fee)} does not hold enough SOL to pay the network fee. Send SOL to the wallet and retry (${err})`;
      case "ProgramAccountNotFound":
        return `a program this transaction calls does not exist on this cluster (${err})`;
      case "BlockhashNotFound":
        return `the network no longer recognizes this transaction's blockhash. Retry the request (${err})`;
      case "AlreadyProcessed":
        return `an identical transaction was already processed. Retry the request to build a fresh one (${err})`;
      default:
        return `the transaction ${humanizeVariantName(err)} (${err})`;
    }
  }

  if (err !== null && typeof err === "object") {
    const record = err as Record<string, unknown>;

    const instruction = record.InstructionError;
    if (Array.isArray(instruction) && instruction.length === 2) {
      const [index, detail] = instruction;
      return `instruction ${String(index)} was rejected: ${describeInstructionErrorDetail(detail)} (${raw})`;
    }

    const rent = record.InsufficientFundsForRent;
    if (rent !== null && typeof rent === "object") {
      const accountIndex = (rent as Record<string, unknown>).account_index;
      return `account ${String(accountIndex)} would be left below the rent-exempt minimum; the transaction needs more SOL for rent (${raw})`;
    }
  }

  return raw;
}
