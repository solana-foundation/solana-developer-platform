/**
 * Translate a Solana `TransactionError` from vault execution into a sentence a
 * dashboard user can act on.
 *
 * The chain answers with bare variants (`"AccountNotFound"`,
 * `{ InstructionError: [1, { Custom: 6001 }] }`) that surface verbatim in the
 * deposit/withdraw modal, where "AccountNotFound" reads as a mystery rather
 * than "your wallet has no SOL". The raw variant is kept in parentheses so
 * operators and log searches still see the real value, in the same quoted-JSON
 * form the old messages used.
 *
 * This is a deliberate divergence from private-channels'
 * `describeTransactionErr` (services/private-channels/tx-error.ts), which keeps
 * the variant verbatim because its `failure_reason` audience is operators. The
 * earn audience is a dashboard customer, so prose wins here; the raw payload is
 * capped at the same 2000 chars that helper uses.
 *
 * Wording depends on who pays the fee when the caller knows: the fee-payer
 * failures name the customer's wallet under `wallet-pays` and SDP's sponsor
 * under `sponsored`, because telling a customer to fund their wallet when SDP's
 * sponsor is broke sends them fixing the wrong thing. Callers that don't know
 * the fee mode (e.g. the reconciler describing a landed failure) omit it and
 * get neutral wording.
 */

import { safeStringify } from "@sdp/solana";
import type { VaultFeeMode } from "./vault-sponsorship";

export interface VaultSimulationVerdict {
  message: string;
  /**
   * "sponsor" when the failing account is SDP's fee sponsor: that is SDP's
   * operational problem, so callers surface it as a retryable 5xx instead of a
   * caller-fault 400 a client would treat as permanent.
   */
  fault: "caller" | "sponsor";
}

function stringifyRaw(err: unknown): string {
  let out: string | undefined;
  try {
    // JSON.stringify returns undefined for undefined/symbol/function inputs.
    out = safeStringify(err);
  } catch {
    out = undefined;
  }
  return (out ?? String(err)).slice(0, 2000);
}

/** "WouldExceedMaxAccountCostLimit" -> "would exceed max account cost limit" */
function humanizeVariantName(name: string): string {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .toLowerCase();
}

const INSTRUCTION_ERROR_DETAILS = new Map<string, string>([
  ["InsufficientFunds", "an account did not hold enough funds"],
  ["UninitializedAccount", "an account it needs has not been initialized"],
  ["AccountNotRentExempt", "an account would be left below the rent-exempt minimum"],
  ["InvalidAccountData", "an account held data the program did not expect"],
  ["MissingRequiredSignature", "a required signature was missing"],
]);

function describeInstructionErrorDetail(detail: unknown): string {
  if (typeof detail === "string") {
    return INSTRUCTION_ERROR_DETAILS.get(detail) ?? `it failed with ${humanizeVariantName(detail)}`;
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
 * One readable line for a `TransactionError` value, raw variant appended in
 * parentheses. Unrecognized shapes fall back to the raw JSON so nothing is
 * hidden. `fee` is an attribution hint for the fee-payer failures; omit it when
 * the fee mode is unknown.
 */
export function describeVaultSimulationError(
  err: unknown,
  fee?: Pick<VaultFeeMode, "kind">
): VaultSimulationVerdict {
  const raw = stringifyRaw(err);
  const sponsored = fee?.kind === "sponsored";
  const feePayerNoun =
    fee === undefined ? "the fee payer" : sponsored ? "SDP's fee sponsor" : "the wallet";
  const feeRemedy = sponsored
    ? "This is a problem on SDP's side, not with the wallet."
    : fee === undefined
      ? "It needs SOL before this can be retried."
      : "Send SOL to the wallet and retry.";
  const feeFault = sponsored ? "sponsor" : "caller";

  if (typeof err === "string") {
    switch (err) {
      case "AccountNotFound":
        return {
          message: `${feePayerNoun} holds no SOL, so it cannot pay the network fee. ${feeRemedy} (${raw})`,
          fault: feeFault,
        };
      case "InsufficientFundsForFee":
        return {
          message: `${feePayerNoun} does not hold enough SOL to pay the network fee. ${feeRemedy} (${raw})`,
          fault: feeFault,
        };
      case "ProgramAccountNotFound":
        return {
          message: `a program this transaction calls does not exist on this cluster (${raw})`,
          fault: "caller",
        };
      case "BlockhashNotFound":
        return {
          message: `the network no longer recognizes this transaction's blockhash. Retry the request (${raw})`,
          fault: "caller",
        };
      case "AlreadyProcessed":
        return {
          message: `an identical transaction was already processed. Retry the request to build a fresh one (${raw})`,
          fault: "caller",
        };
      default:
        return {
          message: `the transaction failed with "${humanizeVariantName(err)}" (${raw})`,
          fault: "caller",
        };
    }
  }

  if (err !== null && typeof err === "object") {
    const record = err as Record<string, unknown>;

    const instruction = record.InstructionError;
    if (Array.isArray(instruction) && instruction.length === 2) {
      const [index, detail] = instruction;
      return {
        message: `instruction at index ${String(index)} was rejected: ${describeInstructionErrorDetail(detail)} (${raw})`,
        fault: "caller",
      };
    }

    const rent = record.InsufficientFundsForRent;
    if (rent !== null && typeof rent === "object" && !Array.isArray(rent)) {
      const accountIndex = (rent as Record<string, unknown>).account_index;
      if (typeof accountIndex === "number" || typeof accountIndex === "bigint") {
        return {
          message: `the account at index ${accountIndex} would be left below the rent-exempt minimum; the transaction needs more SOL for rent (${raw})`,
          fault: "caller",
        };
      }
    }
  }

  return { message: raw, fault: "caller" };
}
