import { createClusterRpc } from "@sdp/rpc/factory";
import { getAccountInfo, type SolanaRpc } from "@sdp/rpc/solana";
import { assertValidAddress } from "@sdp/solana/address";
import { parseDecimalAmount } from "@sdp/solana/amount";
import { SPL_TOKEN_PROGRAMS, WELL_KNOWN_TOKEN_BY_MINT } from "@sdp/types/well-known-tokens";
import {
  type Account,
  type Address,
  address,
  createNoopSigner,
  decompileTransactionMessage,
  type EncodedAccount,
  fetchEncodedAccount,
  getBase64Encoder,
  getCompiledTransactionMessageDecoder,
  getTransactionDecoder,
  isSome,
  type JsonParsedTokenAccount,
  type TransactionSigner,
} from "@solana/kit";
import { fetchSysvarClock } from "@solana/sysvars";
import {
  decodeMint,
  type Extension,
  findAssociatedTokenPda,
  getCreateAssociatedTokenIdempotentInstruction,
  getTransferCheckedInstruction,
  getTransferCheckedInstructionDataDecoder,
  getTransferCheckedWithFeeInstruction,
  getTransferCheckedWithFeeInstructionDataDecoder,
  identifyToken2022Instruction,
  isExtension,
  type Mint,
  Token2022Instruction,
  uiAmountToAmountForScaledUiAmountMintWithoutSimulation,
} from "@solana-program/token-2022";
import { badRequest } from "@/lib/errors";

const SPL_TOKEN_PROGRAM_ID = address(SPL_TOKEN_PROGRAMS["spl-token"]);
const SPL_TOKEN_2022_PROGRAM_ID = address(SPL_TOKEN_PROGRAMS["token-2022"]);
const SPL_TOKEN_PROGRAM_IDS = [SPL_TOKEN_PROGRAM_ID, SPL_TOKEN_2022_PROGRAM_ID] as const;

export type TokenLabelsByMint = ReadonlyMap<string, string>;

interface GetSplTokenBalancesOptions {
  tokenLabelsByMint?: TokenLabelsByMint;
  /** Refuse answers from chain state older than this slot (the node errors instead). */
  minContextSlot?: bigint;
  abortSignal?: AbortSignal;
}

/** The token account an SPL transfer sends from: the owner's largest one for the mint. */
export interface SourceTokenAccount {
  tokenAccount: Address;
  decimals: number;
  /** Base units it held when read. */
  amount: bigint;
  frozen: boolean;
}

/** A source token account with its mint's token program, read once for a send to reuse. */
export interface SplTransferSource extends SourceTokenAccount {
  tokenProgram: Address;
}

function issuedTokenLabel(mint: string, tokenLabelsByMint?: TokenLabelsByMint): string | null {
  return tokenLabelsByMint?.get(mint)?.trim() || null;
}

export function resolveTokenLabel(mint: string, tokenLabelsByMint?: TokenLabelsByMint): string {
  const issuedLabel = issuedTokenLabel(mint, tokenLabelsByMint);
  if (issuedLabel) return issuedLabel;
  const wellKnownToken = WELL_KNOWN_TOKEN_BY_MINT.get(mint);
  return wellKnownToken ? wellKnownToken.symbol : mint;
}

/**
 * Renames each balance to the label the organization issued its mint under, where it
 * did. For balances read without labels, so the read can start before the labels are
 * known and be shared across callers whose labels differ.
 */
export function withIssuedTokenLabels<T extends { mint: string; token: string }>(
  balances: readonly T[],
  tokenLabelsByMint: TokenLabelsByMint
): T[] {
  return balances.map((balance) => {
    const issuedLabel = issuedTokenLabel(balance.mint, tokenLabelsByMint);
    return issuedLabel ? { ...balance, token: issuedLabel } : balance;
  });
}

export async function resolveMintDecimals(rpc: SolanaRpc, mint: Address): Promise<number> {
  const response = await rpc.getTokenSupply(mint, { commitment: "confirmed" }).send();
  const decimals = response.value.decimals;

  if (typeof decimals !== "number" || !Number.isInteger(decimals) || decimals < 0) {
    throw badRequest("Token mint decimals could not be resolved");
  }

  return decimals;
}

function parseTokenAmountInfo(info: JsonParsedTokenAccount): {
  mint: Address;
  amount: bigint;
  decimals: number;
  uiAmount: string;
} {
  return {
    mint: info.mint,
    amount: BigInt(info.tokenAmount.amount),
    decimals: info.tokenAmount.decimals,
    uiAmount: info.tokenAmount.uiAmountString,
  };
}

export async function getSplTokenBalances(
  rpc: SolanaRpc,
  owner: Address,
  options?: GetSplTokenBalancesOptions
): Promise<
  Array<{ token: string; mint: string; amount: string; uiAmount: string; decimals: number }>
> {
  const balancesByMint = new Map<string, { amount: bigint; decimals: number; uiAmount: string }>();
  // One read per token program, independent of each other, so neither waits.
  const responses = await Promise.all(
    SPL_TOKEN_PROGRAM_IDS.map((programId) =>
      rpc
        .getTokenAccountsByOwner(
          owner,
          { programId },
          {
            encoding: "jsonParsed",
            commitment: "confirmed",
            minContextSlot: options?.minContextSlot,
          }
        )
        .send({ abortSignal: options?.abortSignal })
    )
  );

  for (const response of responses) {
    for (const account of response.value) {
      const parsed = parseTokenAmountInfo(account.account.data.parsed.info);
      if (parsed.amount <= 0n) {
        continue;
      }

      const existing = balancesByMint.get(parsed.mint);
      if (existing) {
        existing.amount += parsed.amount;
        continue;
      }

      balancesByMint.set(parsed.mint, {
        amount: parsed.amount,
        decimals: parsed.decimals,
        uiAmount: parsed.uiAmount,
      });
    }
  }

  return Array.from(balancesByMint.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([mint, balance]) => ({
      token: resolveTokenLabel(mint, options?.tokenLabelsByMint),
      mint,
      amount: balance.amount.toString(),
      uiAmount: balance.uiAmount,
      decimals: balance.decimals,
    }));
}

export async function getSplTokenAccountAddresses(
  rpc: SolanaRpc,
  owner: Address
): Promise<Address[]> {
  const addresses: Address[] = [];
  const seen = new Set<string>();
  const responses = await Promise.all(
    SPL_TOKEN_PROGRAM_IDS.map((programId) =>
      rpc
        .getTokenAccountsByOwner(
          owner,
          { programId },
          { encoding: "jsonParsed", commitment: "confirmed" }
        )
        .send()
    )
  );

  for (const response of responses) {
    for (const account of response.value) {
      if (seen.has(account.pubkey)) {
        continue;
      }

      const tokenAccount = assertValidAddress(account.pubkey, "tokenAccount");
      seen.add(tokenAccount);
      addresses.push(tokenAccount);
    }
  }

  return addresses;
}

function assertSupportedTokenProgram(program: string): Address {
  if (program === SPL_TOKEN_PROGRAM_ID || program === SPL_TOKEN_2022_PROGRAM_ID) {
    return address(program);
  }
  throw badRequest("Unsupported token program for mint");
}

export async function resolveMintTokenProgram(rpc: SolanaRpc, mint: Address): Promise<Address> {
  const mintAccountInfo = await getAccountInfo(rpc, mint);
  if (!mintAccountInfo) {
    throw badRequest("Token mint account does not exist");
  }
  return assertSupportedTokenProgram(mintAccountInfo.owner);
}

export async function resolveSourceTokenAccount(
  rpc: SolanaRpc,
  owner: Address,
  mint: Address,
  tokenProgram: Address
): Promise<SourceTokenAccount> {
  const selected = await findSourceTokenAccount(rpc, owner, mint, tokenProgram);

  if (!selected) {
    throw badRequest("Source wallet has no token account for this mint");
  }

  return selected;
}

export async function resolveSourceTokenAccountOrAta(
  rpc: SolanaRpc,
  owner: Address,
  mint: Address,
  tokenProgram: Address
): Promise<{ tokenAccount: Address; decimals: number; exists: boolean }> {
  const [tokenAccount] = await findAssociatedTokenPda({
    owner,
    tokenProgram,
    mint,
  });
  const [tokenAccountInfo, decimals] = await Promise.all([
    getAccountInfo(rpc, tokenAccount),
    resolveMintDecimals(rpc, mint),
  ]);

  return {
    tokenAccount,
    decimals,
    exists: tokenAccountInfo !== null,
  };
}

type TransferFeeConfig = Extract<Extension, { __kind: "TransferFeeConfig" }>;

/** A mint a transfer reads its terms from: the account and its owning token program. */
export interface TransferMint {
  account: EncodedAccount;
  tokenProgram: Address;
}

/**
 * Reads the mint a transfer moves, from the cluster scope's RPC.
 *
 * @param mint - The mint address.
 * @returns The mint's account and the SPL token program that owns it.
 * @throws AppError `BAD_REQUEST` when the mint does not exist or no SPL token program owns it.
 */
export async function readTransferMint(mint: Address): Promise<TransferMint> {
  const account = await fetchEncodedAccount(createClusterRpc(), mint);
  if (!account.exists) {
    throw badRequest("Token mint account does not exist");
  }
  return { account, tokenProgram: assertSupportedTokenProgram(account.programAddress) };
}

type ScaledUiAmountConfig = Extract<Extension, { __kind: "ScaledUiAmountConfig" }>;

/**
 * The Token-2022 extensions that change what a transfer of a mint moves or delivers.
 *
 * @param transferMint - The mint, as `readTransferMint` read it.
 * @returns Its scaled UI amount and transfer fee configs; both undefined on a classic mint.
 * @throws AppError `BAD_REQUEST` when a Token-2022 account does not decode as a mint.
 */
function readAmountExtensions(transferMint: TransferMint): {
  scaledUiAmount: ScaledUiAmountConfig | undefined;
  transferFeeConfig: TransferFeeConfig | undefined;
} {
  if (transferMint.tokenProgram !== SPL_TOKEN_2022_PROGRAM_ID) {
    return { scaledUiAmount: undefined, transferFeeConfig: undefined };
  }
  let mint: Account<Mint>;
  try {
    mint = decodeMint(transferMint.account);
  } catch {
    throw badRequest("Token mint account is not a mint");
  }
  const extensions = isSome(mint.data.extensions) ? mint.data.extensions.value : [];
  return {
    scaledUiAmount: extensions.find((extension) =>
      // biome-ignore lint/security/noSecrets: Token-2022 extension name, not a secret.
      isExtension("ScaledUiAmountConfig", extension)
    ),
    transferFeeConfig: extensions.find((extension) => isExtension("TransferFeeConfig", extension)),
  };
}

/**
 * Refuses a mint with a Token-2022 scaled UI amount or transfer fee, for a flow that builds or
 * settles against the unscaled amount it was given. A mint's extensions are fixed when it is
 * created, so checking once when the flow starts holds for its lifetime.
 *
 * @param mint - The mint address.
 * @param flow - The flow's name, as the refusal says it.
 * @throws AppError `BAD_REQUEST` when the mint has either extension, does not exist, or no SPL
 *   token program owns it.
 */
export async function assertMintMovesUnscaled(
  mint: Address,
  flow: "Payment requests" | "Batch transfers"
): Promise<void> {
  const { scaledUiAmount, transferFeeConfig } = readAmountExtensions(await readTransferMint(mint));
  if (scaledUiAmount || transferFeeConfig) {
    throw badRequest(
      `${flow} don't support tokens with a Token-2022 transfer fee or scaled UI amount yet`
    );
  }
}

/** What a transfer signs: the base units it moves and the fee it states. */
interface TransferTerms {
  baseUnits: bigint;
  /**
   * The fee the program withholds from the recipient, stated on
   * `TransferCheckedWithFee` so a changed fee refuses the transfer instead of
   * settling it short. Null for a mint with no transfer fee config.
   */
  transferFee: bigint | null;
}

/**
 * The fee Token-2022 withholds on a transfer of `baseUnits` in `epoch`: the
 * newer fee from its first epoch on, else the older one, as
 * `ceil(baseUnits × bps / 10000)` capped at its maximum fee. Mirrors the
 * program's `TransferFeeConfig::calculate_epoch_fee`.
 *
 * @param config - The mint's transfer fee config.
 * @param epoch - The epoch the transfer is built in.
 * @param baseUnits - The amount the transfer moves, in base units.
 * @returns The fee in base units.
 */
function calculateEpochTransferFee(
  config: TransferFeeConfig,
  epoch: bigint,
  baseUnits: bigint
): bigint {
  const fee =
    epoch >= config.newerTransferFee.epoch ? config.newerTransferFee : config.olderTransferFee;
  const rawFee = (baseUnits * BigInt(fee.transferFeeBasisPoints) + 9_999n) / 10_000n;
  return rawFee < fee.maximumFee ? rawFee : fee.maximumFee;
}

/**
 * The fewest base units a scaled mint shows as at least the requested UI amount. Token-2022
 * truncates both ways (`ScaledUiAmountConfig::try_ui_amount_into_amount` and
 * `amount_to_ui_amount`), so the truncated conversion can show one UI unit short of what the
 * caller asked to send; one more base unit always covers it. The shown amount mirrors the
 * program's `trunc(base units × multiplier)` in f64. Above a multiplier of 1 the extra base unit
 * can show as up to `multiplier` UI units, so a tiny amount may arrive larger than requested.
 *
 * @param truncatedBaseUnits - The program's truncated UI-to-base-units conversion.
 * @param requestedUiUnits - The requested UI amount at the mint's decimals, exact.
 * @param multiplier - The multiplier in effect.
 * @returns The base units to sign.
 */
function roundUpScaledBaseUnits(
  truncatedBaseUnits: bigint,
  requestedUiUnits: bigint,
  multiplier: number
): bigint {
  const shownUiUnits = BigInt(Math.trunc(Number(truncatedBaseUnits) * multiplier));
  return shownUiUnits < requestedUiUnits ? truncatedBaseUnits + 1n : truncatedBaseUnits;
}

/**
 * The terms a transfer of `amount` signs, read at the cluster's Clock. A
 * Token-2022 mint with a scaled UI amount divides by the multiplier in effect
 * (its new multiplier from the effective timestamp on), the amount its holders
 * see; a mint with a transfer fee config states the fee for the current epoch.
 * Every other mint parses exactly at its decimals and states no fee.
 *
 * The amount passes SDP's decimal grammar first, so a scaled mint refuses a bad
 * amount with the same `AmountError`. The scaled conversion is token-2022's f64
 * helper rounded up so the recipient sees at least `amount`; it loses precision
 * above 2^53 base units.
 *
 * @param transferMint - The mint, as `readTransferMint` read it.
 * @param amount - The decimal amount the caller asked to send.
 * @param decimals - The mint's decimals.
 * @returns The base units moved and the fee stated.
 * @throws AppError `BAD_REQUEST` when a Token-2022 account does not decode as a mint, or a
 *   scaled amount is out of the u64 range.
 */
export async function resolveTransferTerms(
  transferMint: TransferMint,
  amount: string,
  decimals: number
): Promise<TransferTerms> {
  const exactBaseUnits = parseDecimalAmount(amount, decimals);
  const { scaledUiAmount, transferFeeConfig } = readAmountExtensions(transferMint);
  if (!scaledUiAmount && !transferFeeConfig) {
    return { baseUnits: exactBaseUnits, transferFee: null };
  }

  const clock = await fetchSysvarClock(createClusterRpc());
  let baseUnits = exactBaseUnits;
  if (scaledUiAmount) {
    const multiplier =
      clock.unixTimestamp >= scaledUiAmount.newMultiplierEffectiveTimestamp
        ? scaledUiAmount.newMultiplier
        : scaledUiAmount.multiplier;
    let truncatedBaseUnits: bigint;
    try {
      truncatedBaseUnits = uiAmountToAmountForScaledUiAmountMintWithoutSimulation(
        amount,
        decimals,
        multiplier
      );
    } catch {
      throw badRequest("Amount is out of range for this token's scaled UI amount");
    }
    baseUnits = roundUpScaledBaseUnits(truncatedBaseUnits, exactBaseUnits, multiplier);
  }
  return {
    baseUnits,
    transferFee: transferFeeConfig
      ? calculateEpochTransferFee(transferFeeConfig, clock.epoch, baseUnits)
      : null,
  };
}

/**
 * The Token-2022 transfer a signed transaction carries: the base units and decimals on its
 * `TransferChecked` or `TransferCheckedWithFee` instruction, and the fee the latter states. The
 * program refuses a stated fee that is not the one it withholds, so on a landed transaction
 * that is the fee the recipient paid.
 *
 * @param signedTransaction - The base64 wire transaction a transfer row saved before its send.
 * @returns The transfer's base units, decimals and stated fee (null on `TransferChecked`), or
 *   null unless the transaction holds exactly one Token-2022 transfer: a batch chunk's several
 *   transfers do not describe its row's total.
 */
export function readSignedTokenTransfer(
  signedTransaction: string
): { amount: bigint; decimals: number; fee: bigint | null } | null {
  const transaction = getTransactionDecoder().decode(getBase64Encoder().encode(signedTransaction));
  const message = decompileTransactionMessage(
    getCompiledTransactionMessageDecoder().decode(transaction.messageBytes)
  );
  const transfers: { amount: bigint; decimals: number; fee: bigint | null }[] = [];
  for (const instruction of message.instructions) {
    if (
      instruction.programAddress !== SPL_TOKEN_2022_PROGRAM_ID ||
      instruction.data === undefined
    ) {
      continue;
    }
    switch (identifyToken2022Instruction(instruction.data)) {
      case Token2022Instruction.TransferChecked: {
        const { amount, decimals } = getTransferCheckedInstructionDataDecoder().decode(
          instruction.data
        );
        transfers.push({ amount, decimals, fee: null });
        break;
      }
      case Token2022Instruction.TransferCheckedWithFee: {
        const { amount, decimals, fee } = getTransferCheckedWithFeeInstructionDataDecoder().decode(
          instruction.data
        );
        transfers.push({ amount, decimals, fee });
        break;
      }
      default:
        break;
    }
  }
  return transfers.length === 1 ? transfers[0] : null;
}

/**
 * Build the standard SPL transfer instruction pair: an idempotent ATA
 * creation for the destination (rent paid by `ataRentPayer`) followed by a
 * transferChecked from the authority's largest token account, or a
 * transferCheckedWithFee stating the expected fee on a mint with a transfer
 * fee config.
 */
export async function buildSplTransferInstructions(input: {
  authority: TransactionSigner;
  destination: Address;
  mint: Address;
  amount: string;
  ataRentPayer: Address;
  /** The source account this request already read, so the build does not read it again. */
  source?: SplTransferSource;
}) {
  const rpc = createClusterRpc();
  const transferMint = await readTransferMint(input.mint);
  const { tokenProgram } = transferMint;
  const sourceTokenAccount =
    input.source ??
    (await resolveSourceTokenAccount(rpc, input.authority.address, input.mint, tokenProgram));
  const terms = await resolveTransferTerms(transferMint, input.amount, sourceTokenAccount.decimals);
  if (terms.baseUnits <= 0n) {
    throw badRequest("Transfer amount must be greater than zero");
  }

  const [destinationTokenAccount] = await findAssociatedTokenPda({
    owner: input.destination,
    tokenProgram,
    mint: input.mint,
  });
  const transferCheckedInput = {
    source: sourceTokenAccount.tokenAccount,
    mint: input.mint,
    destination: destinationTokenAccount,
    authority: input.authority,
    amount: terms.baseUnits,
    decimals: sourceTokenAccount.decimals,
  };

  return {
    createDestinationAtaInstruction: getCreateAssociatedTokenIdempotentInstruction({
      payer: createNoopSigner(input.ataRentPayer),
      ata: destinationTokenAccount,
      owner: input.destination,
      mint: input.mint,
      tokenProgram,
    }),
    transferInstruction:
      terms.transferFee === null
        ? getTransferCheckedInstruction(transferCheckedInput, { programAddress: tokenProgram })
        : getTransferCheckedWithFeeInstruction(
            { ...transferCheckedInput, fee: terms.transferFee },
            { programAddress: tokenProgram }
          ),
  };
}

async function findSourceTokenAccount(
  rpc: SolanaRpc,
  owner: Address,
  mint: Address,
  tokenProgram: Address
): Promise<SourceTokenAccount | null> {
  const response = await rpc
    .getTokenAccountsByOwner(
      owner,
      { programId: tokenProgram },
      { encoding: "jsonParsed", commitment: "confirmed" }
    )
    .send();
  let selected: SourceTokenAccount | null = null;

  for (const account of response.value) {
    const parsed = parseTokenAmountInfo(account.account.data.parsed.info);
    if (parsed.mint !== mint) {
      continue;
    }

    const tokenAccount = assertValidAddress(account.pubkey, "sourceToken");
    if (selected === null || parsed.amount > selected.amount) {
      selected = {
        tokenAccount,
        decimals: parsed.decimals,
        amount: parsed.amount,
        frozen: account.account.data.parsed.info.state === "frozen",
      };
    }
  }

  return selected;
}
