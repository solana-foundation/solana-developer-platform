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
 * failures name the customer's wallet under `wallet-pays`, SDP's sponsor
 * under `sponsored`, and the partner's named wallet under `caller-provided`,
 * because telling a customer to fund their wallet when someone else's fee
 * wallet is broke sends them fixing the wrong thing. Callers that don't know
 * the fee mode (e.g. the reconciler describing a landed failure) omit it and
 * get neutral wording.
 *
 * Callers holding simulation LOGS pass them too: an `InstructionError` variant
 * alone can be unreadable — `Custom: 1` is the System program's "insufficient
 * lamports", the Token program's "insufficient funds" and every non-Anchor
 * program's own code, all at once — while the failing program's log line names
 * the actual failure. Same precedent as the slippage markers in
 * vault-intent-execution.service.ts.
 */

import { safeStringify } from "@sdp/solana";

/**
 * The slice of `VaultFeeMode` (vault-sponsorship.ts) the wording needs: the
 * kind, plus the ADDRESS for a caller-provided payer so the prose can name
 * the wallet that is actually short. Any full `VaultFeeMode` is assignable.
 */
export type VaultFeeAttribution =
  | { kind: "sponsored" }
  | { kind: "wallet-pays" }
  | { kind: "caller-provided"; feePayer: string };

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

/**
 * The System program's log inside a failed account creation or transfer:
 * `Transfer: insufficient lamports <have>, need <need>`. In a vault plan this
 * is the rent payer coming up short on the token accounts a first deposit (or
 * first exit) creates — the failure the bare variant renders as `Custom: 1`.
 */
const INSUFFICIENT_LAMPORTS_LOG = /Transfer: insufficient lamports (\d+), need (\d+)/;

/** The SPL Token processors' log for a transfer exceeding the balance. */
const INSUFFICIENT_TOKENS_LOG = "Error: insufficient funds";

function rentShortfallLamports(logs: readonly string[]): bigint | undefined {
  for (const line of logs) {
    const match = INSUFFICIENT_LAMPORTS_LOG.exec(line);
    if (!match) continue;
    try {
      const shortfall = BigInt(match[2] as string) - BigInt(match[1] as string);
      return shortfall > 0n ? shortfall : undefined;
    } catch {
      return undefined;
    }
  }
  return undefined;
}

/** `1918899n` → `"0.001918899"`, trailing zeros trimmed. */
function formatSol(lamports: bigint): string {
  const digits = lamports.toString().padStart(10, "0");
  const whole = digits.slice(0, -9);
  const fraction = digits.slice(-9).replace(/0+$/, "");
  return fraction === "" ? whole : `${whole}.${fraction}`;
}

/**
 * A sharper verdict than the `InstructionError` variant alone can give, read
 * from the failing program's own logs. Only ever REFINES — when no known log
 * signature matches, the caller falls through to the variant-based wording.
 */
function describeInstructionFailureFromLogs(
  logs: readonly string[],
  raw: string,
  fee?: VaultFeeAttribution
): VaultSimulationVerdict | undefined {
  const shortfall = rentShortfallLamports(logs);
  if (shortfall !== undefined) {
    if (fee?.kind === "sponsored") {
      // Post-PRO-1736 the sponsor funds rent alongside the fee, so a rent
      // shortfall under sponsorship is SDP's operational problem, exactly like
      // a broke fee payer — callers turn "sponsor" into a retryable 5xx.
      return {
        message:
          `SDP's fee sponsor could not fund the rent for a token account this transaction ` +
          `creates (${formatSol(shortfall)} SOL short). This is a problem on SDP's side, ` +
          `not with the wallet. (${raw})`,
        fault: "sponsor",
      };
    }
    if (fee?.kind === "caller-provided") {
      // The caller named this fee payer, and it funds rent alongside the fee
      // (the one-identity rule), so the shortfall is the caller's to fix — and
      // the prose must name THAT wallet: telling the end user to fund their
      // own wallet when the partner's fee wallet is broke misdirects them.
      return {
        message:
          `the provided fee payer (${fee.feePayer}) does not hold enough SOL to create a ` +
          `token account this transaction needs: rent requires ${formatSol(shortfall)} more ` +
          `SOL. Fund the fee payer and retry. (${raw})`,
        fault: "caller",
      };
    }
    const noun = fee === undefined ? "the rent payer" : "the wallet";
    const remedy =
      fee === undefined
        ? "It needs SOL before this can be retried."
        : "Send SOL to the wallet and retry.";
    return {
      message:
        `${noun} does not hold enough SOL to create a token account this transaction ` +
        `needs: rent requires ${formatSol(shortfall)} more SOL. ${remedy} (${raw})`,
      fault: "caller",
    };
  }
  if (logs.some((line) => line.includes(INSUFFICIENT_TOKENS_LOG))) {
    return {
      message:
        "a token account does not hold enough tokens for this transaction. " +
        `Check the wallet's token balance and retry. (${raw})`,
      fault: "caller",
    };
  }
  return undefined;
}

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
/** Who to name, what to suggest, and whose fault a fee-payer failure is. */
function feePayerWording(fee?: VaultFeeAttribution): {
  feePayerNoun: string;
  feeRemedy: string;
  feeFault: VaultSimulationVerdict["fault"];
} {
  switch (fee?.kind) {
    case "sponsored":
      return {
        feePayerNoun: "SDP's fee sponsor",
        feeRemedy: "This is a problem on SDP's side, not with the wallet.",
        feeFault: "sponsor",
      };
    case "caller-provided":
      return {
        feePayerNoun: `the provided fee payer (${fee.feePayer})`,
        feeRemedy: "Fund the fee payer and retry.",
        feeFault: "caller",
      };
    case "wallet-pays":
      return {
        feePayerNoun: "the wallet",
        feeRemedy: "Send SOL to the wallet and retry.",
        feeFault: "caller",
      };
    default:
      return {
        feePayerNoun: "the fee payer",
        feeRemedy: "It needs SOL before this can be retried.",
        feeFault: "caller",
      };
  }
}

export function describeVaultSimulationError(
  err: unknown,
  fee?: VaultFeeAttribution,
  logs: readonly string[] = []
): VaultSimulationVerdict {
  const raw = stringifyRaw(err);
  const { feePayerNoun, feeRemedy, feeFault } = feePayerWording(fee);

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
      const refined = describeInstructionFailureFromLogs(logs, raw, fee);
      if (refined) return refined;
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
