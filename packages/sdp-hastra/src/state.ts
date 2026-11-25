import { address } from "@solana/kit";
import type { HastraAddresses, HastraClusterConfig } from "./addresses";
import { addressBytes, deriveHastraAddresses, pda } from "./addresses";
import {
  assertDiscriminator,
  pubkeyAt,
  readI64,
  readI128,
  readU64,
  skipPubkeyVector,
} from "./codec";
import {
  SYSTEM_PROGRAM_ID,
  TOKEN_DECIMALS,
  TOKEN_PROGRAM_ID,
  UPGRADEABLE_LOADER_ID,
} from "./constants";
import { SdpHastraError } from "./errors";
import type { RpcAccount, RpcAccountWire } from "./rpc";
import { decodeRpcAccounts, getMultipleAccountWires, namedVaults } from "./rpc";
import type { HastraRuntime } from "./types";

function requiredAccount(account: RpcAccount | null, address: string): RpcAccount {
  if (!account) {
    throw new SdpHastraError(
      "PROGRAM_MISMATCH",
      `Hastra's required account ${address} does not exist.`
    );
  }
  return account;
}

export function assertOwned(account: RpcAccount, owner: string, label: string): void {
  if (account.owner !== owner) {
    throw new SdpHastraError(
      "PROGRAM_MISMATCH",
      `${label} is owned by ${account.owner}, not the pinned ${owner}.`
    );
  }
}

interface MintConfigState {
  vault: string;
  mint: string;
  vaultAuthority: string;
  redeemVault: string;
  bump: number;
  paused: boolean;
  allowedExternalMintProgram: string;
}

function decodeMintConfig(account: RpcAccount, program: string): MintConfigState {
  assertOwned(account, program, "Hastra vault-mint config");
  const data = account.data;
  assertDiscriminator(data, "account", "Config");
  let offset = 8;
  const vault = pubkeyAt(data, offset, "vault-mint config");
  offset += 32;
  const mint = pubkeyAt(data, offset, "vault-mint config");
  offset += 32;
  offset = skipPubkeyVector(data, offset, "freeze administrators");
  offset = skipPubkeyVector(data, offset, "rewards administrators");
  const vaultAuthority = pubkeyAt(data, offset, "vault-mint config");
  offset += 32;
  const redeemVault = pubkeyAt(data, offset, "vault-mint config");
  offset += 32;
  if (offset + 34 > data.length) {
    throw new SdpHastraError("PROGRAM_MISMATCH", "Hastra's vault-mint config is truncated.");
  }
  const bump = data[offset] ?? -1;
  const pausedByte = data[offset + 1];
  if (pausedByte !== 0 && pausedByte !== 1) {
    throw new SdpHastraError("PROGRAM_MISMATCH", "Hastra's vault-mint pause flag is invalid.");
  }
  return {
    vault,
    mint,
    vaultAuthority,
    redeemVault,
    bump,
    paused: pausedByte === 1,
    allowedExternalMintProgram: pubkeyAt(data, offset + 2, "vault-mint config"),
  };
}

interface StakeConfigState {
  vault: string;
  mint: string;
  bump: number;
  paused: boolean;
}

function decodeStakeConfig(account: RpcAccount, program: string): StakeConfigState {
  assertOwned(account, program, "Hastra vault-stake config");
  const data = account.data;
  assertDiscriminator(data, "account", "StakeConfig");
  let offset = 8;
  const vault = pubkeyAt(data, offset, "vault-stake config");
  offset += 32;
  const mint = pubkeyAt(data, offset, "vault-stake config");
  offset += 32 + 8; // deprecated unbonding_period remains in the deployed layout
  offset = skipPubkeyVector(data, offset, "stake freeze administrators");
  offset = skipPubkeyVector(data, offset, "stake rewards administrators");
  if (offset + 2 > data.length) {
    throw new SdpHastraError("PROGRAM_MISMATCH", "Hastra's vault-stake config is truncated.");
  }
  const bump = data[offset] ?? -1;
  const pausedByte = data[offset + 1];
  if (pausedByte !== 0 && pausedByte !== 1) {
    throw new SdpHastraError("PROGRAM_MISMATCH", "Hastra's vault-stake pause flag is invalid.");
  }
  return { vault, mint, bump, paused: pausedByte === 1 };
}

export interface StakePriceState {
  price: bigint;
  scale: bigint;
  timestamp: bigint;
  maxStaleness: bigint;
  bump: number;
}

function decodeStakePrice(account: RpcAccount, program: string): StakePriceState {
  assertOwned(account, program, "Hastra stake-price config");
  const data = account.data;
  assertDiscriminator(data, "account", "StakePriceConfig");
  if (data.length < 177) {
    throw new SdpHastraError("PROGRAM_MISMATCH", "Hastra's stake-price config is truncated.");
  }
  const price = readI128(data, 136, "stake-price config");
  const scale = readU64(data, 152, "stake-price config");
  const timestamp = readI64(data, 160, "stake-price config");
  const maxStaleness = readI64(data, 168, "stake-price config");
  const bump = data[176] ?? -1;
  if (scale === 0n || maxStaleness < 0n) {
    throw new SdpHastraError(
      "PROGRAM_MISMATCH",
      "Hastra's stake-price scale or staleness bound is invalid."
    );
  }
  return { price, scale, timestamp, maxStaleness, bump };
}

function decodeSingletonPubkeyConfig(
  account: RpcAccount,
  program: string,
  discriminatorName: string,
  label: string
): { address: string; bump: number } {
  assertOwned(account, program, label);
  assertDiscriminator(account.data, "account", discriminatorName);
  if (account.data.length < 41) {
    throw new SdpHastraError("PROGRAM_MISMATCH", `${label} is truncated.`);
  }
  return { address: pubkeyAt(account.data, 8, label), bump: account.data[40] ?? -1 };
}

function decodeStakeVaultConfig(
  account: RpcAccount,
  program: string
): { vaultTokenAccount: string; vaultAuthority: string; bump: number } {
  assertOwned(account, program, "Hastra stake-vault-token config");
  // biome-ignore lint/security/noSecrets: public Anchor account type name, not a credential.
  assertDiscriminator(account.data, "account", "StakeVaultTokenAccountConfig");
  if (account.data.length < 73) {
    throw new SdpHastraError("PROGRAM_MISMATCH", "Hastra's stake-vault-token config is truncated.");
  }
  return {
    vaultTokenAccount: pubkeyAt(account.data, 8, "stake-vault-token config"),
    vaultAuthority: pubkeyAt(account.data, 40, "stake-vault-token config"),
    bump: account.data[72] ?? -1,
  };
}

function decodeMint(
  account: RpcAccount,
  address: string,
  expectedAuthority: string | null
): { supply: bigint } {
  assertOwned(account, TOKEN_PROGRAM_ID, `Hastra mint ${address}`);
  if (account.data.length < 82 || account.data[45] !== 1 || account.data[44] !== TOKEN_DECIMALS) {
    throw new SdpHastraError(
      "PROGRAM_MISMATCH",
      `Hastra mint ${address} is uninitialized or no longer uses ${TOKEN_DECIMALS} decimals.`
    );
  }
  if (expectedAuthority !== null) {
    const authorityOption = account.data.readUInt32LE(0);
    const authority = pubkeyAt(account.data, 4, `mint ${address}`);
    if (authorityOption !== 1 || authority !== expectedAuthority) {
      throw new SdpHastraError(
        "PROGRAM_MISMATCH",
        `Hastra mint ${address} no longer has the pinned program mint authority.`
      );
    }
  }
  return { supply: readU64(account.data, 36, `mint ${address}`) };
}

export function decodeTokenAccount(
  account: RpcAccount,
  label: string,
  expectedMint: string,
  expectedOwner: string
): { amount: bigint; frozen: boolean; delegate: string | null; delegatedAmount: bigint } {
  assertOwned(account, TOKEN_PROGRAM_ID, label);
  if (
    account.data.length < 165 ||
    pubkeyAt(account.data, 0, label) !== expectedMint ||
    pubkeyAt(account.data, 32, label) !== expectedOwner
  ) {
    throw new SdpHastraError("PROGRAM_MISMATCH", `${label} has an unexpected mint or authority.`);
  }
  const state = account.data[108];
  if (state !== 1 && state !== 2) {
    throw new SdpHastraError("PROGRAM_MISMATCH", `${label} is not an initialized SPL account.`);
  }
  const delegateTag = account.data.readUInt32LE(72);
  if (delegateTag !== 0 && delegateTag !== 1) {
    throw new SdpHastraError("PROGRAM_MISMATCH", `${label} has a malformed delegate.`);
  }
  return {
    amount: readU64(account.data, 64, label),
    frozen: state === 2,
    delegate: delegateTag === 1 ? pubkeyAt(account.data, 76, label) : null,
    delegatedAmount: readU64(account.data, 121, label),
  };
}

export function assertOwnerTokenUsable(
  account: RpcAccount | null,
  label: string,
  mint: string,
  owner: string,
  code: "DEPOSIT_REFUSED" | "WITHDRAW_REFUSED" | "REDEMPTION_REFUSED",
  requiredAmount?: bigint
): { amount: bigint; frozen: false } {
  if (!account) {
    throw new SdpHastraError(code, `${label} does not exist.`);
  }
  const decoded = decodeTokenAccount(account, label, mint, owner);
  if (decoded.frozen) {
    throw new SdpHastraError(code, `${label} is frozen and cannot move tokens.`);
  }
  if (requiredAmount !== undefined && decoded.amount < requiredAmount) {
    throw new SdpHastraError(code, `${label} does not hold the requested amount.`);
  }
  return { amount: decoded.amount, frozen: false };
}

export function assertExistingOwnerTokenUsable(
  account: RpcAccount | null,
  label: string,
  mint: string,
  owner: string,
  code: "DEPOSIT_REFUSED" | "WITHDRAW_REFUSED" | "REDEMPTION_REFUSED"
): { amount: bigint; frozen: false } | null {
  if (!account) return null;
  return assertOwnerTokenUsable(account, label, mint, owner, code);
}

export interface HastraState {
  addresses: HastraAddresses;
  mintConfig: MintConfigState;
  stakeConfig: StakeConfigState;
  stakePrice: StakePriceState;
  mintVaultTokenAccount: string;
  stakeVaultTokenAccount: string;
  stakeVaultLiquidity: bigint;
  depositVaultFrozen: boolean;
  redeemVaultFrozen: boolean;
  stakeVaultFrozen: boolean;
}

function assertEqual(actual: unknown, expected: unknown, label: string): void {
  if (actual !== expected) {
    throw new SdpHastraError(
      "PROGRAM_MISMATCH",
      `${label} drifted from SDP's pinned Hastra v0.0.6 deployment.`
    );
  }
}

export async function loadHastraState(
  runtime: HastraRuntime,
  config: HastraClusterConfig,
  addresses?: HastraAddresses
): Promise<HastraState> {
  return (await readHastraState(runtime, config, [], addresses)).state;
}

/**
 * The validated live state in one request when the configs still name the
 * remembered vaults, else two. `extra`, the operation's own accounts, rides
 * the first request (so they fail as `PROGRAM_MISMATCH`, as their own reads
 * did) and comes back undecoded, for the operation to decode where it reads it.
 */
export async function readHastraState(
  runtime: HastraRuntime,
  config: HastraClusterConfig,
  extra: readonly string[] = [],
  /** Already-derived addresses; with them the identity read is sent before this yields. */
  derived?: HastraAddresses
): Promise<{ state: HastraState; extra: (RpcAccountWire | null)[] }> {
  const { deployment } = config;
  const addresses = derived ?? (await deriveHastraAddresses(deployment));
  const firstAddresses = [
    deployment.vaultMintProgramAddress,
    deployment.vaultStakeProgramAddress,
    addresses.mintConfig,
    addresses.mintVaultTokenAccountConfig,
    addresses.stakeConfig,
    addresses.stakeVaultTokenAccountConfig,
    addresses.stakePriceConfig,
    config.depositMint,
    deployment.wYldsMint,
    deployment.primeMint,
  ] as const;
  const remembered = namedVaults.get(config.cluster) ?? [];
  const values = await getMultipleAccountWires(
    runtime,
    [...firstAddresses, ...remembered, ...extra],
    "PROGRAM_MISMATCH"
  );
  const first = decodeRpcAccounts(values, firstAddresses);
  const [mintProgram, stakeProgram] = first;
  if (
    !mintProgram?.executable ||
    mintProgram.owner !== UPGRADEABLE_LOADER_ID ||
    !stakeProgram?.executable ||
    stakeProgram.owner !== UPGRADEABLE_LOADER_ID
  ) {
    throw new SdpHastraError(
      "PROGRAM_MISMATCH",
      "A pinned Hastra program is missing, non-executable, or no longer upgradeable-program owned."
    );
  }

  const mintConfig = decodeMintConfig(
    requiredAccount(first[2] ?? null, addresses.mintConfig),
    deployment.vaultMintProgramAddress
  );
  const mintVaultConfig = decodeSingletonPubkeyConfig(
    requiredAccount(first[3] ?? null, addresses.mintVaultTokenAccountConfig),
    deployment.vaultMintProgramAddress,
    "VaultTokenAccountConfig",
    "Hastra vault-mint token-account config"
  );
  const stakeConfig = decodeStakeConfig(
    requiredAccount(first[4] ?? null, addresses.stakeConfig),
    deployment.vaultStakeProgramAddress
  );
  const stakeVaultConfig = decodeStakeVaultConfig(
    requiredAccount(first[5] ?? null, addresses.stakeVaultTokenAccountConfig),
    deployment.vaultStakeProgramAddress
  );
  const stakePrice = decodeStakePrice(
    requiredAccount(first[6] ?? null, addresses.stakePriceConfig),
    deployment.vaultStakeProgramAddress
  );

  decodeMint(requiredAccount(first[7] ?? null, config.depositMint), config.depositMint, null);
  decodeMint(
    requiredAccount(first[8] ?? null, deployment.wYldsMint),
    deployment.wYldsMint,
    addresses.mintAuthority
  );
  decodeMint(
    requiredAccount(first[9] ?? null, deployment.primeMint),
    deployment.primeMint,
    addresses.stakeMintAuthority
  );

  assertEqual(mintConfig.vault, config.depositMint, "Hastra vault-mint deposit mint");
  assertEqual(mintConfig.mint, deployment.wYldsMint, "Hastra vault-mint receipt mint");
  assertEqual(
    mintConfig.allowedExternalMintProgram,
    deployment.vaultStakeProgramAddress,
    "Hastra external mint program"
  );
  assertEqual(stakeConfig.vault, deployment.wYldsMint, "Hastra stake vault mint");
  assertEqual(stakeConfig.mint, deployment.primeMint, "Hastra PRIME mint");
  assertEqual(
    stakeVaultConfig.vaultAuthority,
    addresses.stakeVaultAuthority,
    "Hastra stake vault authority"
  );

  const mintProgramKey = address(deployment.vaultMintProgramAddress);
  const stakeProgramKey = address(deployment.vaultStakeProgramAddress);
  assertEqual(
    mintConfig.bump,
    (await pda(mintProgramKey, "config"))[1],
    "Hastra vault-mint config bump"
  );
  assertEqual(
    mintVaultConfig.bump,
    (
      await pda(
        mintProgramKey,
        "vault_token_account_config",
        addressBytes(address(addresses.mintConfig))
      )
    )[1],
    "Hastra vault-token config bump"
  );
  assertEqual(
    stakeConfig.bump,
    (await pda(stakeProgramKey, "stake_config"))[1],
    "Hastra stake config bump"
  );
  assertEqual(
    stakeVaultConfig.bump,
    (
      await pda(
        stakeProgramKey,
        "stake_vault_token_account_config",
        addressBytes(address(addresses.stakeConfig))
      )
    )[1],
    "Hastra stake-vault config bump"
  );
  assertEqual(
    stakePrice.bump,
    (
      await pda(stakeProgramKey, "stake_price_config", addressBytes(address(addresses.stakeConfig)))
    )[1],
    "Hastra stake-price config bump"
  );

  if (mintConfig.redeemVault === SYSTEM_PROGRAM_ID) {
    throw new SdpHastraError(
      "PROGRAM_MISMATCH",
      "Hastra's operator redemption vault has not been initialized."
    );
  }
  const vaultAddresses = [
    mintVaultConfig.address,
    mintConfig.redeemVault,
    stakeVaultConfig.vaultTokenAccount,
  ] as const;
  const held = new Map<string, RpcAccountWire | null>(
    remembered.map((address, index) => [address, values[firstAddresses.length + index] ?? null])
  );
  const unread = vaultAddresses.filter((address) => !held.has(address));
  if (unread.length > 0) {
    const reread = await getMultipleAccountWires(runtime, unread, "PROGRAM_MISMATCH");
    for (const [index, address] of unread.entries()) held.set(address, reread[index] ?? null);
  }
  const vaultAccounts = decodeRpcAccounts(
    vaultAddresses.map((address) => held.get(address) ?? null),
    vaultAddresses
  );
  const depositVault = decodeTokenAccount(
    requiredAccount(vaultAccounts[0] ?? null, mintVaultConfig.address),
    "Hastra USDC deposit vault",
    config.depositMint,
    // Unlike the redeem and stake authorities, this is not a PDA in v0.0.6:
    // initialize records the pre-existing deposit token account's owner in
    // Config and Deposit constrains the vault against that stored authority.
    mintConfig.vaultAuthority
  );
  const redeemVault = decodeTokenAccount(
    requiredAccount(vaultAccounts[1] ?? null, mintConfig.redeemVault),
    "Hastra USDC redemption vault",
    config.depositMint,
    addresses.redeemVaultAuthority
  );
  const stakeVault = decodeTokenAccount(
    requiredAccount(vaultAccounts[2] ?? null, stakeVaultConfig.vaultTokenAccount),
    "Hastra wYLDS stake vault",
    deployment.wYldsMint,
    addresses.stakeVaultAuthority
  );
  namedVaults.set(config.cluster, vaultAddresses);

  return {
    state: {
      addresses,
      mintConfig,
      stakeConfig,
      stakePrice,
      mintVaultTokenAccount: mintVaultConfig.address,
      stakeVaultTokenAccount: stakeVaultConfig.vaultTokenAccount,
      stakeVaultLiquidity: stakeVault.amount,
      depositVaultFrozen: depositVault.frozen,
      redeemVaultFrozen: redeemVault.frozen,
      stakeVaultFrozen: stakeVault.frozen,
    },
    extra: values.slice(firstAddresses.length + remembered.length),
  };
}
