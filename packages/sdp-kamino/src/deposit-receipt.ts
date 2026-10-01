import { formatDecimalAmount, parseDecimalAmount } from "@sdp/solana/amount";
import { SPL_TOKEN_PROGRAMS } from "@sdp/types";
import { getBase58Encoder, signature } from "@solana/kit";
import { TOKEN_PROGRAM_ADDRESS } from "@solana-program/token";
import { kaminoClusterConfig } from "./programs";
import { createKaminoRpc } from "./rpc";
import type { KaminoRuntime } from "./types";

const DEPOSIT = [242, 35, 198, 137, 82, 225, 242, 182];
const DEPOSIT_WITH_FLOOR = [74, 127, 128, 80, 4, 221, 193, 91];
const U64_MAX = (1n << 64n) - 1n;

export interface KaminoDepositReceiptInput {
  signature: string;
  vault: string;
  owner: string;
  tokenMint: string;
  shareMint: string;
  requestedAmount: string;
}

export interface KaminoDepositReceipt {
  amount: string;
  sharesOut: string;
}

function object(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function atoms(value: unknown): bigint | null {
  if (typeof value !== "string" || !/^\d{1,20}$/.test(value)) return null;
  const amount = BigInt(value);
  return amount <= U64_MAX ? amount : null;
}

function index(value: unknown): number | null {
  if (typeof value !== "number" && typeof value !== "bigint") return null;
  const numeric = Number(value);
  return Number.isSafeInteger(numeric) && numeric >= 0 ? numeric : null;
}

function tokenDecimals(
  meta: Record<string, unknown>,
  accountKeys: unknown[],
  account: string,
  mint: string,
  owner: string
): number | null {
  const accountIndex = accountKeys.findIndex((key) => object(key)?.pubkey === account);
  if (accountIndex < 0) return null;
  const observations = [meta.preTokenBalances, meta.postTokenBalances]
    .flatMap((balances) => (Array.isArray(balances) ? balances : []))
    .map(object)
    .filter((balance) => balance && index(balance.accountIndex) === accountIndex);
  if (observations.length === 0) return null;
  let decimals: number | null = null;
  for (const balance of observations) {
    if (balance?.mint !== mint || balance.owner !== owner) return null;
    const observed = index(object(balance.uiTokenAmount)?.decimals);
    if (observed === null || observed > 255 || (decimals !== null && observed !== decimals)) {
      return null;
    }
    decimals = observed;
  }
  return decimals;
}

function decodeDepositInstruction(value: unknown, program: string) {
  const instruction = object(value);
  if (instruction?.programId !== program || typeof instruction.data !== "string") return null;
  // A 24-byte deposit encodes to at most 33 base58 characters.
  if (instruction.data.length > 33) return null;
  let bytes: readonly number[];
  try {
    bytes = Array.from(getBase58Encoder().encode(instruction.data));
  } catch {
    return null;
  }
  const hasFloor = bytes.length === 24 && DEPOSIT_WITH_FLOOR.every((b, i) => bytes[i] === b);
  const isDeposit = bytes.length === 16 && DEPOSIT.every((b, i) => bytes[i] === b);
  return hasFloor || isDeposit ? { instruction, bytes, hasFloor } : null;
}

function observeTransfers(instructions: unknown[], accounts: unknown[]) {
  const [
    owner,
    ,
    tokenVault,
    tokenMint,
    vaultAuthority,
    shareMint,
    source,
    destination,
    ,
    tokenProgram,
    shareProgram,
  ] = accounts;
  let debit = 0n;
  let minted = 0n;
  for (const value of instructions) {
    const child = object(value);
    if (!child) return null;
    if (![tokenProgram, shareProgram].includes(child.programId)) continue;
    const parsed = object(child.parsed);
    const info = object(parsed?.info);
    if (!parsed || !info) return null;
    if (info.source === source) {
      if (
        child.programId !== tokenProgram ||
        info.destination !== tokenVault ||
        info.authority !== owner ||
        !["transfer", "transferChecked", "transferCheckedWithFee"].includes(String(parsed.type)) ||
        (info.mint !== undefined && info.mint !== tokenMint)
      )
        return null;
      const amount = atoms(info.amount ?? object(info.tokenAmount)?.amount);
      if (amount === null) return null;
      debit += amount;
    }
    if (info.mint === shareMint && ["mintTo", "mintToChecked"].includes(String(parsed.type))) {
      if (
        child.programId !== shareProgram ||
        info.account !== destination ||
        info.mintAuthority !== vaultAuthority
      ) {
        return null;
      }
      const amount = atoms(info.amount ?? object(info.tokenAmount)?.amount);
      if (amount === null) return null;
      minted += amount;
    }
  }
  return { debit, minted };
}

/**
 * Read transfers inside the exact deposit invocation, not wallet net balances:
 * a preceding swap can credit the same token account in this transaction.
 * Unknown layouts, incomplete metadata and identity mismatches stay unvalued.
 */
export function parseKaminoDepositReceipt(
  response: unknown,
  cluster: KaminoRuntime["cluster"],
  input: KaminoDepositReceiptInput
): KaminoDepositReceipt | null {
  const receipt = object(response);
  const meta = object(receipt?.meta);
  const transaction = object(receipt?.transaction);
  const message = object(transaction?.message);
  if (
    !meta ||
    meta.err !== null ||
    !message ||
    !Array.isArray(transaction?.signatures) ||
    transaction.signatures[0] !== input.signature ||
    !Array.isArray(message.instructions) ||
    !Array.isArray(message.accountKeys) ||
    !Array.isArray(meta.innerInstructions)
  )
    return null;

  const config = kaminoClusterConfig(cluster);
  const deposits = message.instructions.flatMap((value, instructionIndex) => {
    const decoded = decodeDepositInstruction(value, config.kvaultProgramId);
    return decoded ? [{ ...decoded, instructionIndex }] : [];
  });
  if (deposits.length !== 1) return null;
  const { instruction, instructionIndex, bytes, hasFloor } = deposits[0];
  const accounts = instruction.accounts;
  if (!Array.isArray(accounts) || accounts.length < 13) return null;
  const [
    owner,
    vault,
    ,
    tokenMint,
    ,
    shareMint,
    source,
    destination,
    klendProgram,
    tokenProgram,
    shareProgram,
    ,
    vaultProgram,
  ] = accounts;
  if (
    owner !== input.owner ||
    vault !== input.vault ||
    tokenMint !== input.tokenMint ||
    shareMint !== input.shareMint ||
    klendProgram !== config.klendProgramId ||
    vaultProgram !== config.kvaultProgramId ||
    shareProgram !== TOKEN_PROGRAM_ADDRESS ||
    (tokenProgram !== TOKEN_PROGRAM_ADDRESS && tokenProgram !== SPL_TOKEN_PROGRAMS["token-2022"]) ||
    typeof source !== "string" ||
    typeof destination !== "string" ||
    !message.accountKeys.some(
      (key) => object(key)?.pubkey === owner && object(key)?.signer === true
    )
  )
    return null;

  const decimals = tokenDecimals(meta, message.accountKeys, source, input.tokenMint, input.owner);
  const shareDecimals = tokenDecimals(
    meta,
    message.accountKeys,
    destination,
    input.shareMint,
    input.owner
  );
  if (decimals === null || shareDecimals === null) return null;
  const view = new DataView(Uint8Array.from(bytes).buffer);
  const maximum = view.getBigUint64(8, true);
  try {
    if (maximum !== parseDecimalAmount(input.requestedAmount, decimals)) return null;
  } catch {
    return null;
  }
  const groups = meta.innerInstructions
    .map(object)
    .filter((group) => group && index(group.index) === instructionIndex);
  if (groups.length !== 1 || !Array.isArray(groups[0]?.instructions)) return null;
  const transfers = observeTransfers(groups[0].instructions, accounts);
  if (!transfers) return null;
  const { debit, minted } = transfers;
  if (debit <= 0n || debit > maximum || minted <= 0n || minted > U64_MAX) return null;
  if (hasFloor && minted < view.getBigUint64(16, true)) return null;
  return {
    amount: formatDecimalAmount(debit, decimals),
    sharesOut: formatDecimalAmount(minted, shareDecimals),
  };
}

/** Finalized-only receipt lookup; callers must verify the runtime's cluster. */
export async function readKaminoDepositReceipt(
  runtime: KaminoRuntime,
  input: KaminoDepositReceiptInput
): Promise<KaminoDepositReceipt | null> {
  const transaction = await createKaminoRpc(runtime.rpcUrl)
    .getTransaction(signature(input.signature), {
      encoding: "jsonParsed",
      commitment: "finalized",
      maxSupportedTransactionVersion: 0,
    })
    .send();
  return parseKaminoDepositReceipt(transaction, runtime.cluster, input);
}
