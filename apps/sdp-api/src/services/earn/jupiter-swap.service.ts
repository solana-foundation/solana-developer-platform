import {
  badRequest as earnBadRequest,
  providerNotConfigured,
  providerUnavailable,
} from "@sdp/earn/errors";
import type { EarnVaultInstruction, EarnVaultTransactionPlan } from "@sdp/earn/types";
import { isAddress } from "@sdp/solana/address";
import { formatDecimalAmount, parseDecimalAmount } from "@sdp/solana/amount";
import { SPL_TOKEN_PROGRAMS, WELL_KNOWN_TOKEN_BY_MINT } from "@sdp/types";
import { address } from "@solana/kit";
import { findAssociatedTokenPda } from "@solana-program/token-2022";
import { badRequest } from "@/lib/errors";
import { getLogger } from "@/runtime/logger";
import type { Env } from "@/types/env";
import type { VaultDeadline } from "./vault-deadline";

/**
 * Jupiter-routed swap legs for swap-funded Earn deposits.
 *
 * A customer may fund a vault deposit in a stablecoin the vault does not take
 * (pay USDC into a PYUSD-denominated strategy). The gap is closed by a spot
 * swap routed through Jupiter's Swap API, PREPENDED into the same transaction
 * as the vault deposit, so the two legs land atomically or not at all.
 *
 * Everything returned here is plain data in the `EarnVaultTransactionPlan`
 * instruction shape, so the existing vault execution seam — simulate with the
 * owner as fee payer, size-check after lookup-table compression, compile or
 * sign — applies to the composed transaction unchanged. Simulation is what
 * makes the composition safe: it executes the swap and the deposit together
 * against live state before anything is signed.
 *
 * ── Why the deposit is sized to the swap's WORST-CASE output ────────────────
 * Jupiter's Router builds ExactIn swaps: the input is fixed and the output is
 * anything at or above `otherAmountThreshold` (the quote minus the slippage
 * tolerance). The vault deposit amount is encoded statically in its own
 * instruction, so it must be an amount the swap is GUARANTEED to deliver —
 * that is the threshold, not the quote. Output above the threshold stays in
 * the owner's token account as a small remainder (bounded by the slippage
 * tolerance, on stable-stable pairs typically a few bps); sizing to the quote
 * instead would make the whole transaction fail whenever the route moved at
 * all. The response reports both numbers so callers can display the trade-off.
 *
 * ── Credentials ─────────────────────────────────────────────────────────────
 * `JUPITER_SWAP_API_KEY` (Portal key, `x-api-key` header), with
 * `JUPITER_SWAP_API_URL` defaulting to the keyed production base. Fail-closed
 * like every provider credential: no key, no network call, a 503 that names
 * the configuration gap. NEVER log or echo the key.
 */

const DEFAULT_JUPITER_SWAP_API_URL = "https://api.jup.ag/swap/v2";

const REQUEST_TIMEOUT_MS = 10_000;

/**
 * Account headroom asked of Jupiter's router, below its 64 default: the swap
 * shares the transaction with the vault deposit instructions and a memo, which
 * Jupiter cannot know about when it sizes a route. The retry value trades
 * price for compactness when the first composition exceeds the packet limit.
 */
const COMPOSED_SWAP_MAX_ACCOUNTS = 40;
export const RETRY_SWAP_MAX_ACCOUNTS = 24;

/**
 * The instruction trust boundary: Jupiter's answer is response-controlled
 * executable content headed for a transaction the custody wallet or external
 * owner will AUTHORIZE WHOLESALE, so its instructions are admitted against a
 * closed outer contract rather than trusted wholesale:
 *
 * - the only admitted auxiliary operation is an exact idempotent ATA create
 *   for the owner and one of the two requested mints; this stablecoin-only
 *   flow requests no wrapping, tips, platform fees, cleanup, or other work;
 * - the swap instruction's program must be the aggregator itself, so a
 *   "swap" cannot be substituted with a bare token transfer to an attacker's
 *   account, and its fixed accounts plus encoded amount/slippage must match
 *   the requested owner, mints, token accounts, and zero-fee contract;
 * - Jupiter's V2 route plan and remaining-account tail stay opaque. `/build`
 *   exists to expose Metis routing internals for composition, so the pinned
 *   Jupiter aggregator program is the reviewed execution boundary. We bind
 *   its stable outer economic contract instead of reimplementing every DEX
 *   adapter's private account schema;
 * - the ONLY account that may carry the signer flag is the taker, so the
 *   composed transaction can never grow a second authority.
 *
 * A response outside the contract is refused as an upstream fault (503) and
 * nothing is composed or persisted. Pinned ids, deliberately not
 * configuration: widening this set must be a reviewed code change, exactly
 * like the well-known mint catalogue. If Jupiter ships a new router program,
 * builds fail closed until the id is added here.
 */
// biome-ignore lint/security/noSecrets: Jupiter aggregator v6 program id, public on-chain address.
export const JUPITER_AGGREGATOR_PROGRAM_ID = "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4";
// biome-ignore lint/security/noSecrets: SPL Associated Token Account program id, public.
const ASSOCIATED_TOKEN_PROGRAM_ID = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";
const SYSTEM_PROGRAM_ID = "11111111111111111111111111111111";
// biome-ignore lint/security/noSecrets: Jupiter v6 event authority, public on-chain address.
const JUPITER_EVENT_AUTHORITY = "D8cy77BBepLMngZx6ZukaTff5hCt1HrWyKk3Hnd9oitf";

export const EARN_SWAP_ALLOWED_PROGRAM_IDS: ReadonlySet<string> = new Set([
  JUPITER_AGGREGATOR_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
]);

// Anchor instruction discriminators from Jupiter v6's published V2 IDL. The
// request explicitly selects instructionVersion=V2, and only ExactIn V2 route
// variants are admitted. Token-ledger, ExactOut, and legacy variants fail
// closed instead of being interpreted with the wrong account layout.
const ROUTE_V2_DISCRIMINATOR = "bb64facc31c4af14";
const SHARED_ACCOUNTS_ROUTE_V2_DISCRIMINATOR = "d19853937cfed8e9";
const ROUTE_V2_FIXED_BYTES = 8 + 8 + 8 + 2 + 2 + 2;
const SHARED_ACCOUNTS_ROUTE_V2_FIXED_BYTES = 8 + 1 + 8 + 8 + 2 + 2 + 2;
const ROUTE_PLAN_LENGTH_BYTES = 4;

/**
 * ── Compute-unit sizing for the composed transaction ────────────────────────
 * Jupiter's /build answer carries no compute-unit LIMIT (its integration
 * contract says: simulate at the maximum, then rebuild with a buffered, capped
 * limit), and its `computeBudgetInstructions` carry a compute-unit PRICE — a
 * priority fee the vault pipeline deliberately does not pay, so those are
 * never included rather than validated. The limit is derived LOCALLY: the
 * composed plan is first simulated under an explicit maximum-limit
 * instruction, the simulation's `unitsConsumed` is buffered by
 * `COMPUTE_UNIT_HEADROOM` and capped at Solana's 1.4M ceiling, and the plan
 * that is signed or compiled carries that limit as its FIRST instruction.
 * Without this, a high-CU route that fits under the 1.4M cap would be
 * rejected by Solana's per-instruction default budget despite being valid.
 *
 * The instruction is constructed HERE, never taken from the wire, so it is
 * not part of the upstream trust boundary above.
 */
export const COMPUTE_BUDGET_PROGRAM_ID = "ComputeBudget111111111111111111111111111111";
export const MAX_COMPUTE_UNIT_LIMIT = 1_400_000;
/** 15% headroom over the simulated consumption, the buffer Jupiter suggests. */
const COMPUTE_UNIT_HEADROOM_PCT = 15;

/** SetComputeUnitLimit (discriminator 2, u32 LE units), built locally. */
export function computeUnitLimitInstruction(units: number): EarnVaultInstruction {
  const bounded = Math.min(Math.max(Math.ceil(units), 1), MAX_COMPUTE_UNIT_LIMIT);
  const data = Buffer.alloc(5);
  data.writeUInt8(2, 0);
  data.writeUInt32LE(bounded, 1);
  return { programAddress: COMPUTE_BUDGET_PROGRAM_ID, accounts: [], data: data.toString("base64") };
}

/** The plan with a locally-built compute-unit limit as its first instruction. */
export function withComputeUnitLimit(
  plan: EarnVaultTransactionPlan,
  units: number
): EarnVaultTransactionPlan {
  return { ...plan, instructions: [computeUnitLimitInstruction(units), ...plan.instructions] };
}

/** Buffered, capped limit from a probe simulation; the maximum when unreported. */
export function bufferedComputeUnitLimit(unitsConsumed: bigint | undefined): number {
  if (unitsConsumed === undefined || unitsConsumed <= 0n) return MAX_COMPUTE_UNIT_LIMIT;
  const buffered = (unitsConsumed * BigInt(100 + COMPUTE_UNIT_HEADROOM_PCT)) / 100n + 1n;
  return Number(
    buffered > BigInt(MAX_COMPUTE_UNIT_LIMIT) ? BigInt(MAX_COMPUTE_UNIT_LIMIT) : buffered
  );
}

export interface JupiterSwapRequest {
  /** Mint the owner pays with. */
  inputMint: string;
  /** The vault's own deposit mint. */
  outputMint: string;
  /** Swap input in source-token units, decimal string. */
  sourceAmount: string;
  /** The wallet that signs, pays, and receives: custody or external. */
  owner: string;
  /** Swap slippage tolerance, basis points. */
  slippageBps: number;
  /** Route account ceiling; see COMPOSED_SWAP_MAX_ACCOUNTS. */
  maxAccounts?: number;
}

/** The swap leg, normalized to the vault plan's own instruction vocabulary. */
export interface JupiterSwapLeg {
  /** Setup + swap + cleanup, in execution order. Compute-budget and tip
   * instructions are deliberately excluded: the vault pipeline neither prices
   * priority fees nor tips, and the composed transaction must simulate exactly
   * as it will be sent. */
  instructions: EarnVaultInstruction[];
  /** Lookup tables the composed plan must be compressed with. */
  lookupTableAddresses: string[];
  /** What the swap consumes, source-token units, decimal string. */
  sourceAmount: string;
  /** Quoted output at the live rate, deposit-token units, decimal string. */
  quotedAmount: string;
  /**
   * The GUARANTEED output floor (quote minus tolerance), deposit-token units.
   * This is the amount a composed vault deposit must be sized to.
   */
  minOutAmount: string;
  /** Quoted price impact as a decimal ratio string. */
  priceImpactPct: string;
  /** Venue labels along the route, for display and diagnostics. */
  routeLabels: string[];
  slippageBps: number;
}

interface JupiterApiInstruction {
  programId: string;
  accounts: { pubkey: string; isSigner: boolean; isWritable: boolean }[];
  data: string;
}

interface JupiterBuildResponse {
  inputMint: string;
  outputMint: string;
  inAmount: string;
  outAmount: string;
  otherAmountThreshold: string;
  slippageBps: number;
  priceImpactPct: string | number;
  routePlan?: { swapInfo?: { label?: string } }[];
  computeBudgetInstructions?: JupiterApiInstruction[];
  setupInstructions?: JupiterApiInstruction[];
  swapInstruction: JupiterApiInstruction;
  cleanupInstruction?: JupiterApiInstruction | null;
  otherInstructions?: JupiterApiInstruction[];
  tipInstruction?: JupiterApiInstruction | null;
  addressesByLookupTableAddress?: Record<string, string[]> | null;
}

interface ExpectedSwapAccounts {
  sourceTokenAccount: string;
  destinationTokenAccount: string;
  sourceTokenProgram: string;
  destinationTokenProgram: string;
}

function resolveJupiterSwapConfig(env: Env): { url: string; apiKey: string } {
  const apiKey = env.JUPITER_SWAP_API_KEY?.trim();
  if (!apiKey) {
    throw providerNotConfigured(
      "Swap-funded deposits are not configured: JUPITER_SWAP_API_KEY is not set for this deployment"
    );
  }
  return {
    url: (env.JUPITER_SWAP_API_URL?.trim() || DEFAULT_JUPITER_SWAP_API_URL).replace(/\/+$/, ""),
    apiKey,
  };
}

/**
 * Decimals for a mint this service is allowed to reason about. Swap legs move
 * only well-known, deliberately pinned stablecoin mints (both the funding side
 * and every catalogued vault deposit token), so an unknown mint is a refusal —
 * scaling an amount with guessed decimals is exactly how a 6-vs-9 mixup moves
 * a thousandfold the intended value.
 */
export function requireWellKnownMintDecimals(mint: string, role: string): number {
  const token = WELL_KNOWN_TOKEN_BY_MINT.get(mint);
  if (!token) {
    throw badRequest(`Swap-funded deposits do not support this ${role}: unrecognized mint ${mint}`);
  }
  return token.decimals;
}

/**
 * Jupiter wire instruction → the vault plan's plain-data instruction, admitted
 * against the trust boundary above: allowlisted program, valid addresses, and
 * no signer other than the taker.
 */
function toEarnVaultInstruction(
  instruction: JupiterApiInstruction,
  taker: string
): EarnVaultInstruction {
  if (!isAddress(instruction.programId)) {
    throw providerUnavailable("Jupiter returned an instruction with an invalid program address");
  }
  if (!EARN_SWAP_ALLOWED_PROGRAM_IDS.has(instruction.programId)) {
    throw providerUnavailable(
      "Jupiter returned an instruction for a program outside the swap contract",
      { programId: instruction.programId }
    );
  }
  return {
    programAddress: instruction.programId,
    accounts: instruction.accounts.map((account) => {
      if (!isAddress(account.pubkey)) {
        throw providerUnavailable(
          "Jupiter returned an instruction with an invalid account address"
        );
      }
      if (account.isSigner && account.pubkey !== taker) {
        // The taker is the only authority this transaction may carry; a
        // foreign signer slot would either brick the transaction or, worse,
        // widen what the owner's wholesale signature authorizes.
        throw providerUnavailable(
          "Jupiter returned an instruction that requires a signer other than the owner",
          { signer: account.pubkey }
        );
      }
      // Numeric AccountRole wire format (see EarnVaultAccountRef): bit 0 is
      // writable, bit 1 is signer — 0 readonly, 1 writable, 2 readonly-signer,
      // 3 writable-signer.
      return {
        address: account.pubkey,
        role: (account.isSigner ? 2 : 0) + (account.isWritable ? 1 : 0),
      };
    }),
    data: instruction.data,
  };
}

function decodeInstructionData(data: string): Buffer {
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(data)) {
    throw providerUnavailable("Jupiter returned an instruction with malformed base64 data");
  }
  return Buffer.from(data, "base64");
}

function sameAccount(
  actual: JupiterApiInstruction["accounts"][number] | undefined,
  expected: { pubkey: string; isSigner: boolean; isWritable: boolean }
): boolean {
  return (
    actual !== undefined &&
    actual.pubkey === expected.pubkey &&
    actual.isSigner === expected.isSigner &&
    actual.isWritable === expected.isWritable
  );
}

function isExpectedAtaCreate(
  instruction: JupiterApiInstruction,
  taker: string,
  mint: string,
  tokenAccount: string,
  tokenProgram: string
): boolean {
  const accounts = instruction.accounts;
  const data = decodeInstructionData(instruction.data);
  return (
    instruction.programId === ASSOCIATED_TOKEN_PROGRAM_ID &&
    data.length === 1 &&
    data[0] === 1 &&
    accounts.length === 6 &&
    sameAccount(accounts[0], { pubkey: taker, isSigner: true, isWritable: true }) &&
    sameAccount(accounts[1], { pubkey: tokenAccount, isSigner: false, isWritable: true }) &&
    sameAccount(accounts[2], { pubkey: taker, isSigner: false, isWritable: false }) &&
    sameAccount(accounts[3], { pubkey: mint, isSigner: false, isWritable: false }) &&
    sameAccount(accounts[4], {
      pubkey: SYSTEM_PROGRAM_ID,
      isSigner: false,
      isWritable: false,
    }) &&
    sameAccount(accounts[5], { pubkey: tokenProgram, isSigner: false, isWritable: false })
  );
}

function requireSwapAccount(
  accounts: JupiterApiInstruction["accounts"],
  index: number,
  expected: { pubkey: string; isSigner: boolean; isWritable: boolean },
  role: string
): void {
  if (!sameAccount(accounts[index], expected)) {
    throw providerUnavailable(`Jupiter returned a swap with an unexpected ${role}`);
  }
}

function validateSwapInstruction(
  instruction: JupiterApiInstruction,
  request: JupiterSwapRequest,
  expected: ExpectedSwapAccounts,
  inputAtoms: bigint,
  quotedOutAtoms: bigint
): void {
  if (instruction.programId !== JUPITER_AGGREGATOR_PROGRAM_ID) {
    throw providerUnavailable(
      "Jupiter returned a swap instruction that does not run its aggregator program",
      { programId: instruction.programId }
    );
  }

  const data = decodeInstructionData(instruction.data);
  const discriminator = data.subarray(0, 8).toString("hex");
  const sharedAccounts = discriminator === SHARED_ACCOUNTS_ROUTE_V2_DISCRIMINATOR;
  const route = discriminator === ROUTE_V2_DISCRIMINATOR;
  if (!sharedAccounts && !route) {
    throw providerUnavailable(
      "Jupiter returned a swap instruction outside the ExactIn V2 contract"
    );
  }

  const minimumBytes =
    (sharedAccounts ? SHARED_ACCOUNTS_ROUTE_V2_FIXED_BYTES : ROUTE_V2_FIXED_BYTES) +
    ROUTE_PLAN_LENGTH_BYTES;
  if (data.length < minimumBytes) {
    throw providerUnavailable("Jupiter returned a truncated swap instruction");
  }

  // V2 puts the fixed economic contract before its variable route plan. A
  // shared route adds one byte of router-account identity after the Anchor
  // discriminator; the remaining fields use the same widths.
  const amountOffset = sharedAccounts ? 9 : 8;
  if (
    data.readBigUInt64LE(amountOffset) !== inputAtoms ||
    data.readBigUInt64LE(amountOffset + 8) !== quotedOutAtoms ||
    data.readUInt16LE(amountOffset + 16) !== request.slippageBps ||
    data.readUInt16LE(amountOffset + 18) !== 0 ||
    data.readUInt16LE(amountOffset + 20) !== 0
  ) {
    throw providerUnavailable(
      "Jupiter returned a swap instruction that does not match the requested amount, slippage, or zero-fee contract"
    );
  }

  // `/build` deliberately exposes Metis' opaque route plan and venue account
  // tail for transaction composition. The pinned Jupiter program interprets
  // those internals and remains the execution trust boundary. Locally decoding
  // its private Swap enum or DEX-specific account schemas would be incomplete,
  // brittle, and would silently disable valid routes as Jupiter evolves. The
  // stable contract we can enforce is the program, instruction variant, fixed
  // owner/token accounts, exact input and quoted output, slippage, and zero fees.

  const accounts = instruction.accounts;
  if (route) {
    requireSwapAccount(
      accounts,
      0,
      { pubkey: request.owner, isSigner: true, isWritable: false },
      "owner authority"
    );
    requireSwapAccount(
      accounts,
      1,
      { pubkey: expected.sourceTokenAccount, isSigner: false, isWritable: true },
      "owner source token account"
    );
    requireSwapAccount(
      accounts,
      2,
      { pubkey: expected.destinationTokenAccount, isSigner: false, isWritable: true },
      "owner destination token account"
    );
    requireSwapAccount(
      accounts,
      3,
      { pubkey: request.inputMint, isSigner: false, isWritable: false },
      "source mint"
    );
    requireSwapAccount(
      accounts,
      4,
      { pubkey: request.outputMint, isSigner: false, isWritable: false },
      "destination mint"
    );
    requireSwapAccount(
      accounts,
      5,
      { pubkey: expected.sourceTokenProgram, isSigner: false, isWritable: false },
      "source token program"
    );
    requireSwapAccount(
      accounts,
      6,
      { pubkey: expected.destinationTokenProgram, isSigner: false, isWritable: false },
      "destination token program"
    );
    const explicitDestination = accounts[7];
    if (
      !sameAccount(explicitDestination, {
        pubkey: JUPITER_AGGREGATOR_PROGRAM_ID,
        isSigner: false,
        isWritable: false,
      }) &&
      !sameAccount(explicitDestination, {
        pubkey: expected.destinationTokenAccount,
        isSigner: false,
        isWritable: true,
      })
    ) {
      throw providerUnavailable("Jupiter returned a swap with an unrelated output destination");
    }
    requireSwapAccount(
      accounts,
      8,
      { pubkey: JUPITER_EVENT_AUTHORITY, isSigner: false, isWritable: false },
      "event authority"
    );
    requireSwapAccount(
      accounts,
      9,
      { pubkey: JUPITER_AGGREGATOR_PROGRAM_ID, isSigner: false, isWritable: false },
      "aggregator program account"
    );
  } else {
    requireSwapAccount(
      accounts,
      0,
      { pubkey: accounts[0]?.pubkey ?? "", isSigner: false, isWritable: false },
      "program authority"
    );
    requireSwapAccount(
      accounts,
      1,
      { pubkey: request.owner, isSigner: true, isWritable: false },
      "owner authority"
    );
    requireSwapAccount(
      accounts,
      2,
      { pubkey: expected.sourceTokenAccount, isSigner: false, isWritable: true },
      "owner source token account"
    );
    requireSwapAccount(
      accounts,
      3,
      { pubkey: accounts[3]?.pubkey ?? "", isSigner: false, isWritable: true },
      "program source token account"
    );
    requireSwapAccount(
      accounts,
      4,
      { pubkey: accounts[4]?.pubkey ?? "", isSigner: false, isWritable: true },
      "program destination token account"
    );
    requireSwapAccount(
      accounts,
      5,
      { pubkey: expected.destinationTokenAccount, isSigner: false, isWritable: true },
      "owner destination token account"
    );
    requireSwapAccount(
      accounts,
      6,
      { pubkey: request.inputMint, isSigner: false, isWritable: false },
      "source mint"
    );
    requireSwapAccount(
      accounts,
      7,
      { pubkey: request.outputMint, isSigner: false, isWritable: false },
      "destination mint"
    );
    requireSwapAccount(
      accounts,
      8,
      { pubkey: expected.sourceTokenProgram, isSigner: false, isWritable: false },
      "source token program"
    );
    requireSwapAccount(
      accounts,
      9,
      { pubkey: expected.destinationTokenProgram, isSigner: false, isWritable: false },
      "destination token program"
    );
    requireSwapAccount(
      accounts,
      10,
      { pubkey: JUPITER_EVENT_AUTHORITY, isSigner: false, isWritable: false },
      "event authority"
    );
    requireSwapAccount(
      accounts,
      11,
      { pubkey: JUPITER_AGGREGATOR_PROGRAM_ID, isSigner: false, isWritable: false },
      "aggregator program account"
    );
  }
}

function swapLegInstructions(
  body: JupiterBuildResponse,
  request: JupiterSwapRequest,
  expected: ExpectedSwapAccounts,
  inputAtoms: bigint,
  quotedOutAtoms: bigint
): EarnVaultInstruction[] {
  if (!body.swapInstruction) {
    throw providerUnavailable("Jupiter answered without a swap instruction");
  }
  const setupInstructions = body.setupInstructions ?? [];
  const seenSetups = new Set<string>();
  for (const instruction of setupInstructions) {
    const source = isExpectedAtaCreate(
      instruction,
      request.owner,
      request.inputMint,
      expected.sourceTokenAccount,
      expected.sourceTokenProgram
    );
    const destination = isExpectedAtaCreate(
      instruction,
      request.owner,
      request.outputMint,
      expected.destinationTokenAccount,
      expected.destinationTokenProgram
    );
    const identity = source ? "source" : destination ? "destination" : null;
    if (identity === null || seenSetups.has(identity)) {
      throw providerUnavailable(
        "Jupiter returned a setup instruction outside the requested owner ATA contract"
      );
    }
    seenSetups.add(identity);
  }
  if (
    body.cleanupInstruction != null ||
    (body.otherInstructions?.length ?? 0) > 0 ||
    body.tipInstruction != null
  ) {
    throw providerUnavailable(
      "Jupiter returned auxiliary instructions that this stablecoin swap did not request"
    );
  }
  validateSwapInstruction(body.swapInstruction, request, expected, inputAtoms, quotedOutAtoms);
  const ordered: JupiterApiInstruction[] = [...setupInstructions, body.swapInstruction];
  return ordered.map((instruction) => toEarnVaultInstruction(instruction, request.owner));
}

/**
 * Ask Jupiter's Router for an ExactIn swap as raw instructions.
 *
 * `GET {base}/build` — the instructions-only surface. The meta-aggregator
 * (`/order` + `/execute`) is deliberately not used: it returns an assembled
 * transaction Jupiter itself executes, and this leg must instead ride inside
 * a transaction SDP simulates, sizes and (on the custody path) signs.
 *
 * Throws:
 * - `PROVIDER_NOT_CONFIGURED` (503) when no API key is deployed;
 * - 400 `AppError` when Jupiter refuses the pair/amount (no route, devnet
 *   mints, dust) — the caller's request is the thing to change;
 * - `PROVIDER_UNAVAILABLE`-shaped 502 text when Jupiter answers garbage.
 */
export async function fetchJupiterSwapLeg(
  env: Env,
  deadline: VaultDeadline,
  request: JupiterSwapRequest
): Promise<JupiterSwapLeg> {
  const { url, apiKey } = resolveJupiterSwapConfig(env);
  const sourceDecimals = requireWellKnownMintDecimals(request.inputMint, "funding token");
  const depositDecimals = requireWellKnownMintDecimals(request.outputMint, "deposit token");
  const sourceToken = WELL_KNOWN_TOKEN_BY_MINT.get(request.inputMint);
  const destinationToken = WELL_KNOWN_TOKEN_BY_MINT.get(request.outputMint);
  if (!sourceToken || !destinationToken) {
    throw badRequest("Swap-funded deposits require recognized funding and deposit mints");
  }

  const amountAtoms = parseDecimalAmount(request.sourceAmount, sourceDecimals);
  if (amountAtoms <= 0n) {
    throw badRequest("Swap amount must be greater than zero at the funding token's precision");
  }
  const sourceTokenProgram = SPL_TOKEN_PROGRAMS[sourceToken.tokenProgram];
  const destinationTokenProgram = SPL_TOKEN_PROGRAMS[destinationToken.tokenProgram];
  const [[sourceTokenAccount], [destinationTokenAccount]] = await Promise.all([
    findAssociatedTokenPda({
      owner: address(request.owner),
      mint: address(request.inputMint),
      tokenProgram: address(sourceTokenProgram),
    }),
    findAssociatedTokenPda({
      owner: address(request.owner),
      mint: address(request.outputMint),
      tokenProgram: address(destinationTokenProgram),
    }),
  ]);
  const expectedAccounts: ExpectedSwapAccounts = {
    sourceTokenAccount,
    destinationTokenAccount,
    sourceTokenProgram,
    destinationTokenProgram,
  };

  const query = new URLSearchParams({
    inputMint: request.inputMint,
    outputMint: request.outputMint,
    amount: amountAtoms.toString(),
    taker: request.owner,
    slippageBps: String(request.slippageBps),
    maxAccounts: String(request.maxAccounts ?? COMPOSED_SWAP_MAX_ACCOUNTS),
    instructionVersion: "V2",
    // Stable-stable legs never touch native SOL; disabling the wrap avoids
    // gratuitous wSOL setup instructions in a transaction that is size-bound.
    wrapAndUnwrapSol: "false",
  });

  const response = await deadline.run("Building the Jupiter swap leg", () =>
    fetch(`${url}/build?${query.toString()}`, {
      headers: { "x-api-key": apiKey, accept: "application/json" },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
  );

  if (!response.ok) {
    const detail = await readJupiterError(response);
    if (response.status >= 400 && response.status < 500 && response.status !== 429) {
      // Jupiter's 4xx names a request problem: no route for the pair, an
      // untradable (e.g. devnet) mint, or an amount below route minimums.
      throw badRequest(`Jupiter could not route this swap: ${detail}`);
    }
    getLogger().error(
      { status: response.status, detail },
      "jupiter swap: build request failed upstream"
    );
    throw earnBadRequest(`Jupiter swap routing is unavailable (upstream ${response.status})`, {
      status: response.status,
    });
  }

  let body: JupiterBuildResponse;
  try {
    body = (await response.json()) as JupiterBuildResponse;
  } catch {
    throw earnBadRequest("Jupiter swap routing returned an unreadable response");
  }
  if (!/^\d+$/.test(body.otherAmountThreshold ?? "") || !/^\d+$/.test(body.outAmount ?? "")) {
    throw earnBadRequest("Jupiter swap routing returned malformed amounts");
  }
  if (
    body.inputMint !== request.inputMint ||
    body.outputMint !== request.outputMint ||
    body.inAmount !== amountAtoms.toString() ||
    body.slippageBps !== request.slippageBps
  ) {
    throw providerUnavailable("Jupiter returned a quote outside the requested swap contract");
  }
  const minOutAtoms = BigInt(body.otherAmountThreshold);
  const quotedOutAtoms = BigInt(body.outAmount);
  if (minOutAtoms <= 0n) {
    throw badRequest("The quoted swap output is zero after slippage; increase the amount");
  }
  if (quotedOutAtoms < minOutAtoms) {
    throw providerUnavailable("Jupiter returned a swap floor above its quoted output");
  }

  return {
    instructions: swapLegInstructions(body, request, expectedAccounts, amountAtoms, quotedOutAtoms),
    lookupTableAddresses: Object.keys(body.addressesByLookupTableAddress ?? {}),
    sourceAmount: request.sourceAmount,
    quotedAmount: formatDecimalAmount(BigInt(body.outAmount), depositDecimals),
    minOutAmount: formatDecimalAmount(minOutAtoms, depositDecimals),
    priceImpactPct: String(body.priceImpactPct ?? "0"),
    routeLabels: (body.routePlan ?? [])
      .map((step) => step.swapInfo?.label)
      .filter((label): label is string => typeof label === "string" && label.length > 0),
    slippageBps: request.slippageBps,
  };
}

async function readJupiterError(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { error?: unknown };
    if (typeof body?.error === "string" && body.error.trim()) return body.error.trim();
  } catch {
    // Fall through to the status line.
  }
  return `HTTP ${response.status}`;
}

/**
 * Prepend a swap leg to a provider-built vault plan.
 *
 * Instruction order is the contract: the swap's setup/swap/cleanup run first
 * so the deposit instruction finds its funds; the caller then appends the
 * request memo last, exactly as an unswapped plan does. Everything else on the
 * plan — asset identity, accepted amounts, `createsShareAccount` — is the
 * PROVIDER's testimony about the deposit leg and passes through untouched.
 * Lookup tables are the union, deduplicated, because both legs were sized
 * against their own tables and compiling without either set could overflow
 * the packet.
 */
export function prependSwapLegToVaultPlan(
  plan: EarnVaultTransactionPlan,
  leg: JupiterSwapLeg
): EarnVaultTransactionPlan {
  return {
    ...plan,
    instructions: [...leg.instructions, ...plan.instructions],
    lookupTables: [...new Set([...leg.lookupTableAddresses, ...plan.lookupTables])],
  };
}
