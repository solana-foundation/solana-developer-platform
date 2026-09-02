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
 *
 * Callers holding simulation LOGS pass them too: an `InstructionError` variant
 * alone can be unreadable — `Custom: 1` is the System program's "insufficient
 * lamports", the Token program's "insufficient funds" and every non-Anchor
 * program's own code, all at once — while the failing program's log line names
 * the actual failure. Same precedent as the slippage markers in
 * vault-intent-execution.service.ts.
 */

import { safeStringify } from "@sdp/solana";
import type { VaultFeeMode } from "./vault-sponsorship";

export interface VaultSimulationVerdict {
  message: string;
  /**
   * "sponsor" when the failure is SDP's operational problem rather than the
   * caller's, so callers surface it as a 5xx instead of a caller-fault 400 a
   * client would treat as permanent.
   */
  fault: "caller" | "sponsor";
  /**
   * Present on every sponsor fault, because the two flavours retry
   * differently: "balance" means SDP's sponsor wallet itself came up short (a
   * refill genuinely clears it, so "retry shortly" is honest), while
   * "prefund" means a program charged the WALLET rent the plan should have
   * pre-funded: a plan defect no retry clears (see the Veda allowed-user
   * prefund in @sdp/veda). Blaming the sponsor's balance for the second
   * flavour is exactly the misattribution this field exists to prevent.
   */
  sponsorCause?: "balance" | "prefund";
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
 * is a rent source coming up short on an account the transaction creates —
 * the failure the bare variant renders as `Custom: 1`.
 */
const INSUFFICIENT_LAMPORTS_LOG = /Transfer: insufficient lamports (\d+), need (\d+)/;

/** The SPL Token processors' log for a transfer exceeding the balance. */
const INSUFFICIENT_TOKENS_LOG = "Error: insufficient funds";

/** `Program <address> invoke [1]` — a TOP-LEVEL instruction entering. */
const TOP_LEVEL_INVOKE_LOG = /^Program ([1-9A-HJ-NP-Za-km-z]{32,44}) invoke \[1\]$/;

const ASSOCIATED_TOKEN_PROGRAM =
  // biome-ignore lint/security/noSecrets: a public Solana program address, not a credential
  "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";

const SYSTEM_PROGRAM = "11111111111111111111111111111111";

interface RentShortfall {
  lamports: bigint;
  /**
   * The top-level program whose instruction the shortfall happened inside:
   * the nearest preceding `invoke [1]` frame. It decides WHOSE money was
   * short: a top-level ATA create's funding payer and a top-level System
   * transfer's source are chosen by the PLAN (the sponsor under sponsorship,
   * via the providers' payer swap and the allowed-user prefund), while a
   * shortfall inside any other program is that program moving lamports from
   * an account IT names: for the vault programs SDP fronts, the depositing
   * wallet, which no transaction-level sponsorship can reach. Undefined when
   * the logs carry no top-level frame (e.g. a truncated tail).
   */
  topLevelProgram: string | undefined;
}

function rentShortfall(logs: readonly string[]): RentShortfall | undefined {
  for (const [index, line] of logs.entries()) {
    const match = INSUFFICIENT_LAMPORTS_LOG.exec(line);
    if (!match) continue;
    let lamports: bigint;
    try {
      lamports = BigInt(match[2] as string) - BigInt(match[1] as string);
    } catch {
      return undefined;
    }
    if (lamports <= 0n) return undefined;
    for (let frame = index - 1; frame >= 0; frame -= 1) {
      const invoke = TOP_LEVEL_INVOKE_LOG.exec(logs[frame] as string);
      if (invoke) return { lamports, topLevelProgram: invoke[1] as string };
    }
    return { lamports, topLevelProgram: undefined };
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
  fee?: Pick<VaultFeeMode, "kind">
): VaultSimulationVerdict | undefined {
  const shortfall = rentShortfall(logs);
  if (shortfall !== undefined) {
    const sol = formatSol(shortfall.lamports);
    const insideAtaCreate = shortfall.topLevelProgram === ASSOCIATED_TOKEN_PROGRAM;
    // A shortfall in a TOP-LEVEL System instruction is a transfer the PLAN
    // authored, whose source the plan chose: under sponsorship that is the
    // sponsor itself running short on the allowed-user prefund it fronts, a
    // refillable balance problem, never a missing prefund. Only a shortfall
    // inside a NON-System, non-ATA program is that program spending an
    // account the plan could not redirect.
    const insidePlanTransfer = shortfall.topLevelProgram === SYSTEM_PROGRAM;
    // Words matched to the failing frame: only the ATA program's create is
    // known to make a TOKEN account; other programs create their own records
    // (Veda's per-user AllowedUser, for one) with the payer as funder rather
    // than creator, and an unattributable frame gets the neutral phrase.
    let created: string;
    let callerPhrase: string;
    if (insideAtaCreate) {
      created = "a token account this transaction creates";
      callerPhrase = "to create a token account this transaction needs";
    } else if (insidePlanTransfer || shortfall.topLevelProgram === undefined) {
      created = "an account this transaction creates";
      callerPhrase = "to create an account this transaction needs";
    } else {
      created = "an account the vault program creates on first use";
      callerPhrase = "to fund an account the vault program creates on first use";
    }
    if (fee?.kind === "sponsored") {
      // Post-PRO-1736 the sponsor funds rent alongside the fee, but only the
      // rent the PLAN charges it: the ATA creates (payer-swapped by the
      // provider) and its own top-level prefund transfer. A shortfall inside
      // any OTHER program is that program spending the WALLET's lamports,
      // which the plan should have pre-funded and did not: still SDP's
      // fault, but a plan defect, not a broke sponsor. The two must not
      // share a message, because "sponsor balance" sends operators refilling
      // a wallet that is fine.
      if (insideAtaCreate || insidePlanTransfer || shortfall.topLevelProgram === undefined) {
        return {
          message:
            `SDP's fee sponsor could not fund the rent for ${created} ` +
            `(${sol} SOL short). This is a problem on SDP's side, ` +
            `not with the wallet. (${raw})`,
          fault: "sponsor",
          sponsorCause: "balance",
        };
      }
      return {
        message:
          `the vault program charges the wallet rent for an account it creates on first use, ` +
          `and this movement did not pre-fund the wallet for it (${sol} SOL short). This is ` +
          `an SDP-side plan defect, not the sponsor's balance and not the wallet. (${raw})`,
        fault: "sponsor",
        sponsorCause: "prefund",
      };
    }
    const noun = fee === undefined ? "the rent payer" : "the wallet";
    const remedy =
      fee === undefined
        ? "It needs SOL before this can be retried."
        : "Send SOL to the wallet and retry.";
    return {
      message:
        `${noun} does not hold enough SOL ${callerPhrase}: ` +
        `rent requires ${sol} more SOL. ${remedy} (${raw})`,
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
export function describeVaultSimulationError(
  err: unknown,
  fee?: Pick<VaultFeeMode, "kind">,
  logs: readonly string[] = []
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
  // A fee-payer failure under sponsorship is always the sponsor's own
  // balance: simulation charges the fee to the sponsor and nothing else.
  const feeCause = sponsored ? ({ sponsorCause: "balance" } as const) : {};

  if (typeof err === "string") {
    switch (err) {
      case "AccountNotFound":
        return {
          message: `${feePayerNoun} holds no SOL, so it cannot pay the network fee. ${feeRemedy} (${raw})`,
          fault: feeFault,
          ...feeCause,
        };
      case "InsufficientFundsForFee":
        return {
          message: `${feePayerNoun} does not hold enough SOL to pay the network fee. ${feeRemedy} (${raw})`,
          fault: feeFault,
          ...feeCause,
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
