import {
  type HastraDeployment,
  hastraDeployment,
  hastraDepositMints,
} from "@sdp/types/hastra-programs";
import type { SolanaCluster } from "@sdp/types/well-known-tokens";
import { PublicKey } from "@solana/web3.js";
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

export function publicKey(field: string, value: string, code: SdpHastraErrorCode): PublicKey {
  try {
    return new PublicKey(value);
  } catch (cause) {
    throw new SdpHastraError(code, `${field} is not a valid Solana address.`, { cause });
  }
}

export function pda(program: PublicKey, ...seeds: (string | Uint8Array)[]): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    seeds.map((seed) => (typeof seed === "string" ? Buffer.from(seed) : Buffer.from(seed))),
    program
  );
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
export function deriveHastraAddresses(deployment: HastraDeployment): HastraAddresses {
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
  const [mintConfig] = pda(mintProgram, "config");
  const [mintVaultTokenAccountConfig] = pda(
    mintProgram,
    "vault_token_account_config",
    mintConfig.toBytes()
  );
  const [mintAuthority] = pda(mintProgram, "mint_authority");
  const [redeemVaultAuthority] = pda(mintProgram, "redeem_vault_authority");
  const [stakeConfig] = pda(stakeProgram, "stake_config");
  const [stakeVaultTokenAccountConfig] = pda(
    stakeProgram,
    "stake_vault_token_account_config",
    stakeConfig.toBytes()
  );
  const [stakeVaultAuthority] = pda(stakeProgram, "vault_authority");
  const [stakeMintAuthority] = pda(stakeProgram, "mint_authority");
  const [stakePriceConfig] = pda(stakeProgram, "stake_price_config", stakeConfig.toBytes());
  return {
    mintConfig: mintConfig.toBase58(),
    mintVaultTokenAccountConfig: mintVaultTokenAccountConfig.toBase58(),
    mintAuthority: mintAuthority.toBase58(),
    redeemVaultAuthority: redeemVaultAuthority.toBase58(),
    stakeConfig: stakeConfig.toBase58(),
    stakeVaultTokenAccountConfig: stakeVaultTokenAccountConfig.toBase58(),
    stakeVaultAuthority: stakeVaultAuthority.toBase58(),
    stakeMintAuthority: stakeMintAuthority.toBase58(),
    stakePriceConfig: stakePriceConfig.toBase58(),
  };
}

export function associatedTokenAddress(owner: PublicKey, mint: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [owner.toBuffer(), new PublicKey(TOKEN_PROGRAM_ID).toBuffer(), mint.toBuffer()],
    new PublicKey(ASSOCIATED_TOKEN_PROGRAM_ID)
  )[0];
}

export function redemptionRequestAddress(
  deployment: HastraDeployment,
  owner: PublicKey
): PublicKey {
  return pda(
    new PublicKey(deployment.vaultMintProgramAddress),
    "redemption_request",
    owner.toBytes()
  )[0];
}

export function legacyTicketAddress(deployment: HastraDeployment, owner: PublicKey): PublicKey {
  return pda(new PublicKey(deployment.vaultStakeProgramAddress), "ticket", owner.toBytes())[0];
}
