/**
 * Translate a Solana `TransactionError` from vault execution into a sentence a
 * dashboard user can act on.
 *
 * The chain answers with bare variants (`"AccountNotFound"`,
 * `{ InstructionError: [1, { Custom: 6001 }] }`) that surface verbatim in the
 * deposit/withdraw modal, where "AccountNotFound" reads as a mystery rather
 * than "your wallet has no SOL". The raw variant is returned BESIDE the prose
 * (`raw`), in the same quoted-JSON form the old messages carried inline, so
 * callers put it where operators look (API `details`, structured logs) and a
 * customer never reads `({"InstructionError":[1,{"Custom":101}]})` in a modal.
 *
 * This is a deliberate divergence from private-channels'
 * `describeTransactionErr` (services/private-channels/tx-error.ts), which keeps
 * the variant verbatim because its `failure_reason` audience is operators. The
 * earn audience is a dashboard customer, so prose wins here; the raw payload is
 * capped at the same 2000 chars that helper uses.
 *
 * A `Custom` code is translated three ways, most specific first: Anchor's
 * framework codes (100–5000) from a pinned table, because "code 101" is a
 * program that does not recognise the instruction, not a vault refusal; the
 * failing program's own `AnchorError occurred. Error Code: … Error Message: …`
 * log line, which names a provider-defined code (6000+) in the provider's own
 * words; and, with neither, the bare code.
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
import {
  isSolanaError,
  SOLANA_ERROR__JSON_RPC__SERVER_ERROR_SEND_TRANSACTION_PREFLIGHT_FAILURE,
  SOLANA_ERROR__TRANSACTION_ERROR__BLOCKHASH_NOT_FOUND,
  unwrapSimulationError,
} from "@solana/kit";
import { ANCHOR_FRAMEWORK_ERRORS } from "./anchor-framework-errors";

/** The cluster's own variant name for a blockhash it does not know. */
const BLOCKHASH_NOT_FOUND_VARIANT = "BlockhashNotFound";

/**
 * True when the cluster refused a transaction because it does not recognize
 * its blockhash, in either shape the earn paths meet: the raw
 * `TransactionError` variant a simulation result carries, or the preflight
 * rejection `sendTransaction` throws. A preflight rejection also proves the
 * bytes were never forwarded to the network.
 */
export function isBlockhashNotFoundError(err: unknown): boolean {
  if (err === BLOCKHASH_NOT_FOUND_VARIANT) return true;
  if (
    !isSolanaError(err, SOLANA_ERROR__JSON_RPC__SERVER_ERROR_SEND_TRANSACTION_PREFLIGHT_FAILURE)
  ) {
    return false;
  }
  return isSolanaError(
    unwrapSimulationError(err),
    SOLANA_ERROR__TRANSACTION_ERROR__BLOCKHASH_NOT_FOUND
  );
}

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
  /** The sentence a customer reads. Never carries the raw variant. */
  message: string;
  /**
   * The chain's own `TransactionError`, quoted-JSON, capped at 2000 chars: the
   * value an operator greps saved logs for. Callers place it in API `details`
   * or a structured log, never in prose.
   */
  raw: string;
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

/** A verdict before `raw` is attached; what the internal describers return. */
type VaultSimulationVerdictBody = Omit<VaultSimulationVerdict, "raw">;

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
  fee?: VaultFeeAttribution
): VaultSimulationVerdictBody | undefined {
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
            `not with the wallet.`,
          fault: "sponsor",
          sponsorCause: "balance",
        };
      }
      return {
        message:
          `the vault program charges the wallet rent for an account it creates on first use, ` +
          `and this movement did not pre-fund the wallet for it (${sol} SOL short). This is ` +
          `an SDP-side plan defect, not the sponsor's balance and not the wallet.`,
        fault: "sponsor",
        sponsorCause: "prefund",
      };
    }
    if (fee?.kind === "caller-provided") {
      // The caller named this fee payer, and the plan charges it exactly the
      // rent the plan itself authors (the ATA creates via the providers' payer
      // swap, the allowed-user prefund transfer), so those frames are the
      // caller's wallet to fund — and the prose must name THAT wallet: telling
      // the end user to fund their own wallet when the partner's fee wallet is
      // broke misdirects them. A shortfall inside any OTHER program is rent
      // the plan should have pre-funded and did not: the same SDP-side plan
      // defect as under sponsorship, which no fee-payer top-up clears.
      if (insideAtaCreate || insidePlanTransfer || shortfall.topLevelProgram === undefined) {
        return {
          message:
            `the provided fee payer (${fee.feePayer}) does not hold enough SOL ` +
            `${callerPhrase}: rent requires ${sol} more SOL. ` +
            `Fund the fee payer and retry.`,
          fault: "caller",
        };
      }
      return {
        message:
          `the vault program charges the wallet rent for an account it creates on first use, ` +
          `and this movement did not pre-fund the wallet for it (${sol} SOL short). This is ` +
          `an SDP-side plan defect, not the provided fee payer's balance and not the wallet.`,
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
        `rent requires ${sol} more SOL. ${remedy}`,
      fault: "caller",
    };
  }
  if (logs.some((line) => line.includes(INSUFFICIENT_TOKENS_LOG))) {
    return {
      message:
        "a token account does not hold enough tokens for this transaction. " +
        `Check the wallet's token balance and retry.`,
      fault: "caller",
    };
  }
  return undefined;
}

/**
 * `Program log: AnchorError occurred. Error Code: SlippageExceeded. Error
 * Number: 6000. Error Message: Slippage tolerance exceeded.` — also the
 * `AnchorError thrown in …` and `AnchorError caused by account: …` prefixes
 * Anchor uses for the same line. The program's own words for its own code.
 */
const ANCHOR_ERROR_LOG =
  /AnchorError .*?Error Code: (\w+)\. Error Number: (\d+)\. Error Message: (.+?)\.?\s*$/;

function anchorErrorFromLogs(
  logs: readonly string[],
  code: number | bigint
): { name: string; message: string } | undefined {
  for (const line of logs) {
    const match = ANCHOR_ERROR_LOG.exec(line);
    if (!match) continue;
    if (BigInt(match[2] as string) !== BigInt(code)) continue;
    return { name: match[1] as string, message: match[3] as string };
  }
  return undefined;
}

/**
 * One sentence for a `Custom` program error code, most specific source first:
 * the pinned Anchor framework table, then the program's own AnchorError log
 * line, then the bare code. The Anchor name and number stay in parentheses so
 * an operator can still search for them; the sentence in front is for the
 * customer.
 */
function describeCustomProgramError(code: number | bigint, logs: readonly string[]): string {
  const numeric = Number(code);
  const framework = ANCHOR_FRAMEWORK_ERRORS.get(numeric);
  if (framework) {
    const tag = `Anchor ${framework.name}, code ${code}`;
    if (numeric < 1000) {
      return (
        `the program on this cluster does not recognize this instruction (${tag}). ` +
        "The deployed program is an older build than this integration expects"
      );
    }
    if (numeric >= 2000 && numeric < 3000) {
      return `the program's account constraints rejected the transaction: ${framework.message} (${tag})`;
    }
    if (numeric >= 3000 && numeric < 4000) {
      return `the program rejected an account it was given: ${framework.message} (${tag})`;
    }
    return `the program failed inside its framework: ${framework.message} (${tag})`;
  }
  const own = anchorErrorFromLogs(logs, code);
  if (own) return `the program refused it: ${own.message} (${own.name}, code ${code})`;
  return `the program rejected it with error code ${code}`;
}

function describeInstructionErrorDetail(detail: unknown, logs: readonly string[]): string {
  if (typeof detail === "string") {
    return INSTRUCTION_ERROR_DETAILS.get(detail) ?? `it failed with ${humanizeVariantName(detail)}`;
  }
  if (detail !== null && typeof detail === "object") {
    // The RPC delivers the code as a number, a bigint, or — through kit's
    // big-integer-safe JSON — a decimal STRING (`{"Custom":"101"}` is what the
    // dashboard actually showed). All three are the same code.
    const custom = (detail as Record<string, unknown>).Custom;
    if (typeof custom === "number" || typeof custom === "bigint") {
      return describeCustomProgramError(custom, logs);
    }
    if (typeof custom === "string" && /^\d+$/.test(custom)) {
      return describeCustomProgramError(BigInt(custom), logs);
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
  /**
   * A fee-payer failure under sponsorship is always the sponsor's own
   * balance: simulation charges the fee to the sponsor and nothing else.
   */
  feeCause: { sponsorCause: "balance" } | Record<string, never>;
} {
  switch (fee?.kind) {
    case "sponsored":
      return {
        feePayerNoun: "SDP's fee sponsor",
        feeRemedy: "This is a problem on SDP's side, not with the wallet.",
        feeFault: "sponsor",
        feeCause: { sponsorCause: "balance" },
      };
    case "caller-provided":
      return {
        feePayerNoun: `the provided fee payer (${fee.feePayer})`,
        feeRemedy: "Fund the fee payer and retry.",
        feeFault: "caller",
        feeCause: {},
      };
    case "wallet-pays":
      return {
        feePayerNoun: "the wallet",
        feeRemedy: "Send SOL to the wallet and retry.",
        feeFault: "caller",
        feeCause: {},
      };
    default:
      return {
        feePayerNoun: "the fee payer",
        feeRemedy: "It needs SOL before this can be retried.",
        feeFault: "caller",
        feeCause: {},
      };
  }
}

export function describeVaultSimulationError(
  err: unknown,
  fee?: VaultFeeAttribution,
  logs: readonly string[] = []
): VaultSimulationVerdict {
  const raw = stringifyRaw(err);
  return { ...describeVerdictBody(err, raw, fee, logs), raw };
}

function describeVerdictBody(
  err: unknown,
  raw: string,
  fee: VaultFeeAttribution | undefined,
  logs: readonly string[]
): VaultSimulationVerdictBody {
  const { feePayerNoun, feeRemedy, feeFault, feeCause } = feePayerWording(fee);

  if (typeof err === "string") {
    switch (err) {
      case "AccountNotFound":
        return {
          message: `${feePayerNoun} holds no SOL, so it cannot pay the network fee. ${feeRemedy}`,
          fault: feeFault,
          ...feeCause,
        };
      case "InsufficientFundsForFee":
        return {
          message: `${feePayerNoun} does not hold enough SOL to pay the network fee. ${feeRemedy}`,
          fault: feeFault,
          ...feeCause,
        };
      case "ProgramAccountNotFound":
        return {
          message: `a program this transaction calls does not exist on this cluster`,
          fault: "caller",
        };
      case BLOCKHASH_NOT_FOUND_VARIANT:
        return {
          message: `the network no longer recognizes this transaction's blockhash. Retry the request`,
          fault: "caller",
        };
      case "AlreadyProcessed":
        return {
          message: `an identical transaction was already processed. Retry the request to build a fresh one`,
          fault: "caller",
        };
      default:
        return {
          message: `the transaction failed with "${humanizeVariantName(err)}"`,
          fault: "caller",
        };
    }
  }

  if (err !== null && typeof err === "object") {
    const record = err as Record<string, unknown>;

    const instruction = record.InstructionError;
    if (Array.isArray(instruction) && instruction.length === 2) {
      const refined = describeInstructionFailureFromLogs(logs, fee);
      if (refined) return refined;
      const [index, detail] = instruction;
      return {
        message: `instruction at index ${String(index)} was rejected: ${describeInstructionErrorDetail(detail, logs)}`,
        fault: "caller",
      };
    }

    const rent = record.InsufficientFundsForRent;
    if (rent !== null && typeof rent === "object" && !Array.isArray(rent)) {
      const accountIndex = (rent as Record<string, unknown>).account_index;
      if (typeof accountIndex === "number" || typeof accountIndex === "bigint") {
        return {
          message: `the account at index ${accountIndex} would be left below the rent-exempt minimum; the transaction needs more SOL for rent`,
          fault: "caller",
        };
      }
    }
  }

  return { message: raw, fault: "caller" };
}
