import type {
  EarnVaultInstruction,
  EarnVaultParRedemptionLifecycleEvent,
  EarnVaultParRedemptionLifecycleInput,
  EarnVaultParRedemptionQuoteInput,
} from "@sdp/earn/types";
import { MAX_SUPPORTED_TRANSACTION_VERSION } from "@sdp/rpc/transaction-version";
import { PublicKey } from "@solana/web3.js";
import type { HastraClusterConfig } from "./addresses";
import { legacyTicketAddress, pda, publicKey, redemptionRequestAddress } from "./addresses";
import { canonicalAmount, formatAtoms } from "./amounts";
import { assertDiscriminator, discriminator, pubkeyAt, readU64 } from "./codec";
import {
  HASTRA_REQUEST_REUSE_COOLDOWN_BLOCKS,
  MAX_SIGNATURE_HISTORY_PAGES,
  REDEMPTION_REQUEST_ACCOUNT_BYTES,
  SIGNATURE_HISTORY_PAGE_SIZE,
  TOKEN_DECIMALS,
} from "./constants";
import { SdpHastraError } from "./errors";
import { prefundOwnerRentInstruction } from "./instructions";
import type {
  RpcAccount,
  RpcBlockIdentity,
  RpcSignatureHistoryEntry,
  RpcTransactionLifecycle,
} from "./rpc";
import { getAccount, nonNegativeSafeInteger, rentExemptMinimum, rpcRequest } from "./rpc";
import { assertOwned } from "./state";
import type { HastraRuntime } from "./types";

/** `account` is the live read of `legacyTicketAddress(owner)`. */
export function decodeLegacyTicket(
  account: RpcAccount | null,
  config: HastraClusterConfig,
  owner: PublicKey
): PublicKey | null {
  const ticket = legacyTicketAddress(config.deployment, owner);
  if (!account) return null;
  assertOwned(account, config.deployment.vaultStakeProgramAddress, "Hastra legacy ticket");
  assertDiscriminator(account.data, "account", "UnbondingTicket");
  if (account.data.length < 64 || pubkeyAt(account.data, 8, "legacy ticket") !== owner.toBase58()) {
    throw new SdpHastraError(
      "PROGRAM_MISMATCH",
      "Hastra's legacy unbonding ticket is truncated or belongs to another owner."
    );
  }
  return ticket;
}

/**
 * `RedemptionRequest` is derived from only the owner, so a still-valid cancel
 * or same-amount operator completion from the prior cycle would also name the
 * recreated account. The program cannot distinguish cycles. Refuse reuse
 * until more than the recent-blockhash window has elapsed in block-height
 * terms; using height rather than wall time remains safe across a chain halt.
 */
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: finalized state, authenticated paged history, and block-height expiry form one fail-closed proof.
async function assertRedemptionRequestReuseSafe(
  runtime: HastraRuntime,
  config: HastraClusterConfig,
  requestAddress: string
): Promise<void> {
  // A confirmed close can make the account disappear before the close itself
  // is finalized. Finalized state must also prove absence before finalized
  // history is allowed to identify the prior cycle's closing event.
  if ((await getAccount(runtime, requestAddress, "REQUEST_UNREADABLE", "finalized")) !== null) {
    throw new SdpHastraError(
      "REDEMPTION_REFUSED",
      "This wallet's prior Hastra request has not finalized closed yet."
    );
  }

  let before: string | undefined;
  let closingSlot: number | null = null;
  let exhausted = false;
  for (let page = 0; page < MAX_SIGNATURE_HISTORY_PAGES; page += 1) {
    const options: { commitment: "finalized"; limit: number; before?: string } = {
      commitment: "finalized",
      limit: SIGNATURE_HISTORY_PAGE_SIZE,
    };
    if (before) options.before = before;
    const history = await rpcRequest<RpcSignatureHistoryEntry[]>(
      runtime,
      "getSignaturesForAddress",
      [requestAddress, options],
      "REQUEST_UNREADABLE",
      "checking Hastra request-address history"
    );
    if (!Array.isArray(history)) {
      throw new SdpHastraError(
        "REQUEST_UNREADABLE",
        "The Solana RPC returned malformed Hastra request-address history."
      );
    }
    if (history.length === 0) {
      exhausted = true;
      break;
    }

    for (const entry of history) {
      if (!entry || typeof entry !== "object" || !Object.hasOwn(entry, "err")) {
        throw new SdpHastraError(
          "REQUEST_UNREADABLE",
          "The Solana RPC returned malformed Hastra request history."
        );
      }
      if (entry.err !== null) {
        continue;
      }
      if (
        typeof entry.signature !== "string" ||
        entry.signature.length === 0 ||
        !nonNegativeSafeInteger(entry.slot)
      ) {
        throw new SdpHastraError(
          "REQUEST_UNREADABLE",
          "The Solana RPC returned malformed successful Hastra request history."
        );
      }
      const transaction = await rpcRequest<RpcTransactionLifecycle | null>(
        runtime,
        "getTransaction",
        [
          entry.signature,
          {
            commitment: "finalized",
            encoding: "json",
            maxSupportedTransactionVersion: MAX_SUPPORTED_TRANSACTION_VERSION,
          },
        ],
        "REQUEST_UNREADABLE",
        "authenticating prior Hastra request history"
      );
      if (
        !transaction?.meta ||
        transaction.meta.err !== null ||
        !Array.isArray(transaction.meta.logMessages)
      ) {
        // A successful finalized signature can only be classified as
        // unrelated after its complete logs are available. Skipping an
        // unavailable transaction could hide a newer close and authorize PDA
        // reuse from an older cycle before that newer close has expired.
        throw new SdpHastraError(
          "REQUEST_UNREADABLE",
          "The Solana RPC could not authenticate a successful Hastra request-history transaction."
        );
      }
      const events = parseParLifecycleEvents(config, {
        providerReference: config.deployment.primeMint,
        requestAddress,
        logs: transaction.meta.logMessages,
        // Only event authenticity matters here; block height, not wall time,
        // enforces expiry below.
        blockTime: "0",
        shareDecimals: TOKEN_DECIMALS,
        assetDecimals: TOKEN_DECIMALS,
      });
      if (
        events.some(
          (event) => event.kind === "redemptionCancelled" || event.kind === "redemptionFulfilled"
        )
      ) {
        closingSlot = entry.slot;
        break;
      }
      if (events.some((event) => event.kind === "redemptionRequested")) {
        // We scan newest to oldest. Reaching a creation without first seeing
        // its authenticated close means finalized account state and history
        // disagree, so an older cycle's close cannot safely authorize reuse.
        throw new SdpHastraError(
          "REQUEST_UNREADABLE",
          "The Solana RPC could not prove how the prior Hastra request closed."
        );
      }
    }
    if (closingSlot !== null) break;
    const last = history.at(-1);
    if (history.length < SIGNATURE_HISTORY_PAGE_SIZE) {
      exhausted = true;
      break;
    }
    if (typeof last?.signature !== "string" || last.signature.length === 0) {
      throw new SdpHastraError(
        "REQUEST_UNREADABLE",
        "The Solana RPC returned an unpageable Hastra request history."
      );
    }
    before = last.signature;
  }
  if (closingSlot === null) {
    if (!exhausted) {
      throw new SdpHastraError(
        "REQUEST_UNREADABLE",
        "Hastra request history is too large to prove safe PDA reuse."
      );
    }
    // No authenticated Hastra lifecycle ever used this deterministic address;
    // unrelated or failed mentions do not turn a first request into a reuse.
    return;
  }
  const [closingBlock, currentBlockHeight] = await Promise.all([
    rpcRequest<RpcBlockIdentity | null>(
      runtime,
      "getBlock",
      [closingSlot, { commitment: "finalized", transactionDetails: "none", rewards: false }],
      "REQUEST_UNREADABLE",
      "reading the last Hastra request block"
    ),
    rpcRequest<number>(
      runtime,
      "getBlockHeight",
      [{ commitment: "finalized" }],
      "REQUEST_UNREADABLE",
      "reading finalized Solana block height"
    ),
  ]);
  const closingBlockHeight = closingBlock?.blockHeight;
  if (!nonNegativeSafeInteger(closingBlockHeight) || !nonNegativeSafeInteger(currentBlockHeight)) {
    throw new SdpHastraError(
      "REQUEST_UNREADABLE",
      "The Solana RPC could not prove that Hastra's prior request transactions expired."
    );
  }
  if (currentBlockHeight <= closingBlockHeight + HASTRA_REQUEST_REUSE_COOLDOWN_BLOCKS) {
    throw new SdpHastraError(
      "REDEMPTION_REFUSED",
      "This wallet's prior Hastra request closed too recently. Wait for its signed transactions " +
        "to expire before opening another request."
    );
  }
}

type ParRedemptionSource =
  | { kind: "shares"; shares: { text: string; atoms: bigint } }
  | { kind: "intermediate"; amount: { text: string; atoms: bigint } };

export function parRedemptionSource(input: EarnVaultParRedemptionQuoteInput): ParRedemptionSource {
  if (input.shares !== undefined && input.intermediateAmount === undefined) {
    return { kind: "shares", shares: canonicalAmount(input.shares, "Share amount") };
  }
  if (input.intermediateAmount !== undefined && input.shares === undefined) {
    return {
      kind: "intermediate",
      amount: canonicalAmount(input.intermediateAmount, "wYLDS amount"),
    };
  }
  throw new SdpHastraError(
    "INVALID_AMOUNT",
    "A Hastra par request redeems either PRIME shares or held wYLDS, exactly one of the two."
  );
}

/**
 * The request half both par sources share, so neither can skip it: one open
 * request per owner, the reuse cooldown for its nonce-less PDA, and the
 * sponsor's prefund of the rent `request_redeem` charges the owner.
 */
export async function admitParRequest(args: {
  runtime: HastraRuntime;
  config: HastraClusterConfig;
  owner: PublicKey;
  sponsor: PublicKey | undefined;
}): Promise<{ request: PublicKey; prefund: EarnVaultInstruction | undefined }> {
  const request = redemptionRequestAddress(args.config.deployment, args.owner);
  if ((await getAccount(args.runtime, request.toBase58(), "REQUEST_UNREADABLE")) !== null) {
    throw new SdpHastraError(
      "REDEMPTION_REFUSED",
      "This wallet already has an open Hastra redemption request; complete or cancel it first."
    );
  }
  await assertRedemptionRequestReuseSafe(args.runtime, args.config, request.toBase58());
  // The reuse check above proves the request PDA absent at build time, so a
  // sponsor's prefund is exactly one account's rent and the program's create
  // consumes it at execution. A PDA created in between leaves the owner the
  // prefund as dust, the same bounded residual the Veda allowed-user prefund
  // accepts.
  if (!args.sponsor) return { request, prefund: undefined };
  const requestRentLamports = await rentExemptMinimum(
    args.runtime,
    REDEMPTION_REQUEST_ACCOUNT_BYTES,
    "redemption-request"
  );
  return {
    request,
    prefund: prefundOwnerRentInstruction(args.sponsor, args.owner, BigInt(requestRentLamports)),
  };
}

interface RedemptionRequestState {
  owner: string;
  amount: bigint;
  mint: string;
  bump: number;
}

export function decodeRedemptionRequest(
  account: RpcAccount,
  config: HastraClusterConfig,
  requestAddress: string
): RedemptionRequestState {
  assertOwned(account, config.deployment.vaultMintProgramAddress, "Hastra redemption request");
  assertDiscriminator(account.data, "account", "RedemptionRequest");
  if (account.data.length < REDEMPTION_REQUEST_ACCOUNT_BYTES) {
    throw new SdpHastraError("REQUEST_UNREADABLE", "Hastra's redemption request is truncated.");
  }
  const request = {
    owner: pubkeyAt(account.data, 8, "redemption request"),
    amount: readU64(account.data, 40, "redemption request"),
    mint: pubkeyAt(account.data, 48, "redemption request"),
    bump: account.data[80] ?? -1,
  };
  const derived = redemptionRequestAddress(
    config.deployment,
    new PublicKey(request.owner)
  ).toBase58();
  if (
    derived !== requestAddress ||
    request.mint !== config.deployment.wYldsMint ||
    request.bump !==
      pda(
        new PublicKey(config.deployment.vaultMintProgramAddress),
        "redemption_request",
        new PublicKey(request.owner).toBytes()
      )[1] ||
    request.amount === 0n
  ) {
    throw new SdpHastraError(
      "REQUEST_UNREADABLE",
      "Hastra's redemption request does not match its deterministic owner, mint, or amount."
    );
  }
  return request;
}

function programEventLogs(
  logs: readonly string[] | null,
  expectedProgram: string
): readonly Buffer[] {
  if (!logs) return [];
  const stack: string[] = [];
  const data: Buffer[] = [];
  for (const log of logs) {
    const invocation = /^Program ([1-9A-HJ-NP-Za-km-z]{32,44}) invoke \[(\d+)\]$/.exec(log);
    if (invocation) {
      const depth = Number(invocation[2]);
      if (!Number.isSafeInteger(depth) || depth < 1 || depth > stack.length + 1) {
        stack.length = 0;
        continue;
      }
      stack.length = depth - 1;
      stack.push(invocation[1] ?? "");
      continue;
    }
    const completion = /^Program ([1-9A-HJ-NP-Za-km-z]{32,44}) (?:success|failed:.*)$/.exec(log);
    if (completion) {
      if (stack.at(-1) === completion[1]) stack.pop();
      else stack.length = 0;
      continue;
    }
    if (stack.at(-1) === expectedProgram && log.startsWith("Program data: ")) {
      try {
        data.push(Buffer.from(log.slice("Program data: ".length), "base64"));
      } catch {
        // A malformed provider log is not an event.
      }
    }
  }
  return data;
}

const REQUESTED_EVENT_DISCRIMINATOR = discriminator("event", "RedemptionRequested");
const CANCELLED_EVENT_DISCRIMINATOR = discriminator("event", "RedemptionCancelled");
const FULFILLED_EVENT_DISCRIMINATOR = discriminator("event", "RedeemCompleted");

export function parseParLifecycleEvents(
  config: HastraClusterConfig,
  input: EarnVaultParRedemptionLifecycleInput
): readonly EarnVaultParRedemptionLifecycleEvent[] {
  if (input.shareDecimals !== TOKEN_DECIMALS || input.assetDecimals !== TOKEN_DECIMALS) {
    throw new SdpHastraError(
      "REQUEST_UNREADABLE",
      "Hastra lifecycle events were requested with a mint scale other than six decimals."
    );
  }
  const requestedAddress = publicKey(
    "requestAddress",
    input.requestAddress,
    "REQUEST_UNREADABLE"
  ).toBase58();
  type ParsedLifecycleEvent =
    | {
        kind: "redemptionRequested" | "redemptionCancelled";
        requestAddress: string;
        owner: string;
        intermediateMint: string;
        intermediateAmount: string;
      }
    | {
        kind: "redemptionFulfilled";
        requestAddress: string;
        owner: string;
        intermediateMint: string;
        intermediateAmount: string;
        assetsPaid: string;
      };
  const decoded: ParsedLifecycleEvent[] = [];
  for (const data of programEventLogs(input.logs, config.deployment.vaultMintProgramAddress)) {
    if (data.length < 8) continue;
    const eventDiscriminator = data.subarray(0, 8);
    let kind: "redemptionRequested" | "redemptionCancelled" | "redemptionFulfilled" | null = null;
    const ownerOffset = 8;
    let amountOffset = 40;
    let mintOffset = 48;
    let vaultOffset = 80;
    if (eventDiscriminator.equals(REQUESTED_EVENT_DISCRIMINATOR)) {
      kind = "redemptionRequested";
      // RedemptionRequested names vault_token_mint before mint; the cancel
      // and completion events name mint before vault.
      mintOffset = 80;
      vaultOffset = 48;
    } else if (eventDiscriminator.equals(CANCELLED_EVENT_DISCRIMINATOR)) {
      kind = "redemptionCancelled";
    } else if (eventDiscriminator.equals(FULFILLED_EVENT_DISCRIMINATOR)) {
      kind = "redemptionFulfilled";
      amountOffset = 72; // user + admin precede amount
      mintOffset = 80;
      vaultOffset = 112;
    }
    if (!kind || data.length < vaultOffset + 32) continue;
    const owner = pubkeyAt(data, ownerOffset, `${kind} event`);
    const requestAddress = redemptionRequestAddress(
      config.deployment,
      new PublicKey(owner)
    ).toBase58();
    if (requestAddress !== requestedAddress) continue;
    const amount = readU64(data, amountOffset, `${kind} event`);
    const mint = pubkeyAt(data, mintOffset, `${kind} event`);
    const vault = pubkeyAt(data, vaultOffset, `${kind} event`);
    if (mint !== config.deployment.wYldsMint || vault !== config.depositMint || amount === 0n) {
      throw new SdpHastraError(
        "REQUEST_UNREADABLE",
        `Hastra's ${kind} event names an unexpected mint or amount.`
      );
    }
    const base = {
      requestAddress,
      owner,
      intermediateMint: mint,
      intermediateAmount: formatAtoms(amount),
    };
    if (kind === "redemptionFulfilled") {
      decoded.push({ kind, ...base, assetsPaid: formatAtoms(amount) });
    } else {
      decoded.push({ kind, ...base });
    }
  }
  if (decoded.length === 0) return [];
  if (input.blockTime === null || !/^\d+$/.test(input.blockTime)) {
    throw new SdpHastraError(
      "REQUEST_UNREADABLE",
      "A finalized Hastra lifecycle event has no trustworthy block time."
    );
  }
  const occurredAt = input.blockTime;
  return decoded.map((event): EarnVaultParRedemptionLifecycleEvent => ({ ...event, occurredAt }));
}
