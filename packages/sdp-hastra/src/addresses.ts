import {
  type HastraDeployment,
  hastraDeployment,
  hastraDepositMints,
} from "@sdp/types/hastra-programs";
import type { SolanaCluster } from "@sdp/types/well-known-tokens";
import {
  type Address,
  address,
  getAddressEncoder,
  getProgramDerivedAddress,
  isAddress,
  type ProgramDerivedAddress,
} from "@solana/kit";
import { ASSOCIATED_TOKEN_PROGRAM_ID, TOKEN_PROGRAM_ID } from "./constants";
import { SdpHastraError, type SdpHastraErrorCode } from "./errors";

export interface HastraClusterConfig {
  cluster: SolanaCluster;
  deployment: HastraDeployment;
  depositMint: string;
}

export function hastraClusterConfig(cluster: SolanaCluster): HastraClusterConfig {
  const deployment = hastraDeployment(cluster);
  if (!deployment) {
    throw new SdpHastraError(
      "DEPLOYMENT_NOT_CONFIGURED",
      `Hastra PRIME has no verified ${cluster} deployment.`
    );
  }
  const mints = hastraDepositMints(cluster);
  if (mints.length !== 1 || !mints[0]) {
    throw new SdpHastraError(
      "DEPLOYMENT_NOT_CONFIGURED",
      `Hastra expects exactly one USDC deposit mint on ${cluster} and found ${mints.length}.`
    );
  }
  return { cluster, deployment, depositMint: mints[0] };
}

export function publicKey(field: string, value: string, code: SdpHastraErrorCode): Address {
  if (!isAddress(value)) {
    throw new SdpHastraError(code, `${field} is not a valid Solana address.`);
  }
  return value;
}

export function pda(
  program: Address,
  ...seeds: (string | Uint8Array)[]
): Promise<ProgramDerivedAddress> {
  return getProgramDerivedAddress({ programAddress: program, seeds });
}

/** The 32 bytes of an address, as a PDA seed or instruction argument. */
export function addressBytes(value: Address): Uint8Array {
  return Uint8Array.from(getAddressEncoder().encode(value));
}

export interface HastraAddresses {
  mintConfig: string;
  mintVaultTokenAccountConfig: string;
  mintAuthority: string;
  redeemVaultAuthority: string;
  stakeConfig: string;
  stakeVaultTokenAccountConfig: string;
  stakeVaultAuthority: string;
  stakeMintAuthority: string;
  stakePriceConfig: string;
}

/** Deterministic v0.0.6 PDAs, exported so allowlist/audit tests can pin them. */
export async function deriveHastraAddresses(
  deployment: HastraDeployment
): Promise<HastraAddresses> {
  const mintProgram = publicKey(
    "Hastra vault-mint program",
    deployment.vaultMintProgramAddress,
    "PROGRAM_MISMATCH"
  );
  const stakeProgram = publicKey(
    "Hastra vault-stake program",
    deployment.vaultStakeProgramAddress,
    "PROGRAM_MISMATCH"
  );
  const [mintConfig] = await pda(mintProgram, "config");
  const [mintVaultTokenAccountConfig] = await pda(
    mintProgram,
    "vault_token_account_config",
    addressBytes(mintConfig)
  );
  const [mintAuthority] = await pda(mintProgram, "mint_authority");
  const [redeemVaultAuthority] = await pda(mintProgram, "redeem_vault_authority");
  const [stakeConfig] = await pda(stakeProgram, "stake_config");
  const [stakeVaultTokenAccountConfig] = await pda(
    stakeProgram,
    "stake_vault_token_account_config",
    addressBytes(stakeConfig)
  );
  const [stakeVaultAuthority] = await pda(stakeProgram, "vault_authority");
  const [stakeMintAuthority] = await pda(stakeProgram, "mint_authority");
  const [stakePriceConfig] = await pda(
    stakeProgram,
    "stake_price_config",
    addressBytes(stakeConfig)
  );
  return {
    mintConfig: mintConfig,
    mintVaultTokenAccountConfig: mintVaultTokenAccountConfig,
    mintAuthority: mintAuthority,
    redeemVaultAuthority: redeemVaultAuthority,
    stakeConfig: stakeConfig,
    stakeVaultTokenAccountConfig: stakeVaultTokenAccountConfig,
    stakeVaultAuthority: stakeVaultAuthority,
    stakeMintAuthority: stakeMintAuthority,
    stakePriceConfig: stakePriceConfig,
  };
}

export async function associatedTokenAddress(owner: Address, mint: Address): Promise<Address> {
  const [ata] = await getProgramDerivedAddress({
    programAddress: address(ASSOCIATED_TOKEN_PROGRAM_ID),
    seeds: [addressBytes(owner), addressBytes(address(TOKEN_PROGRAM_ID)), addressBytes(mint)],
  });
  return ata;
}

export async function redemptionRequestAddress(
  deployment: HastraDeployment,
  owner: Address
): Promise<Address> {
  const [request] = await pda(
    address(deployment.vaultMintProgramAddress),
    "redemption_request",
    addressBytes(owner)
  );
  return request;
}

export async function legacyTicketAddress(
  deployment: HastraDeployment,
  owner: Address
): Promise<Address> {
  const [ticket] = await pda(
    address(deployment.vaultStakeProgramAddress),
    "ticket",
    addressBytes(owner)
  );
  return ticket;
}
