/**
 * One-off diagnostic: derive the Rings pool PDAs for a mint and check whether
 * they exist on chain. If the registry or vault PDA for USDC is missing on
 * devnet, that's why shields hit InvalidSettlementAccounts (custom 7009).
 *
 * Run: pnpm exec tsx packages/sdp-helius-rings-sdk/scripts/verify-usdc-pdas.ts
 * Env: SOLANA_RPC_URL (or falls back to public devnet)
 */

/** biome-ignore-all lint/security/noSecrets: base58 mint addresses are public constants, not secrets. */

import {
  getProtocolConfigAddress,
  getSolInterfaceAddress,
  getSplAssetCounterAddress,
  getSplAssetRegistryAddress,
  getSplAssetVaultAddress,
} from "@heliuslabs/zolana/addresses";
import { address, createSolanaRpc } from "@solana/kit";

const USDC_MINT = address("4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU");
const SOL_MINT = address("So11111111111111111111111111111111111111112");
const RPC_URL = process.env.SOLANA_RPC_URL ?? "https://api.devnet.solana.com";

async function inspect(label: string, pda: string): Promise<void> {
  const rpc = createSolanaRpc(RPC_URL);
  const response = await rpc.getAccountInfo(address(pda), { encoding: "base64" }).send();
  const value = response.value;
  if (!value) {
    console.log(`  ${label}\n    address: ${pda}\n    status:  MISSING — no account at this PDA\n`);
    return;
  }
  console.log(
    `  ${label}\n    address:  ${pda}\n    status:   EXISTS\n    owner:    ${value.owner}\n    lamports: ${value.lamports}\n    dataLen:  ${value.data[0].length} chars base64\n`
  );
}

async function main() {
  console.log(`RPC: ${RPC_URL.replace(/\?api-key=[^&]+/, "?api-key=***")}\n`);

  console.log("=== Global pool PDAs ===");
  await inspect("protocolConfig", await getProtocolConfigAddress());
  await inspect("splAssetCounter", await getSplAssetCounterAddress());

  console.log("\n=== USDC (4zMMC9…ncDU) ===");
  await inspect("splAssetRegistry(USDC)", await getSplAssetRegistryAddress(USDC_MINT));
  await inspect("splAssetVault(USDC)", await getSplAssetVaultAddress(USDC_MINT));

  console.log("=== SOL (native path, for reference) ===");
  await inspect("solInterface", getSolInterfaceAddress());
  await inspect("splAssetRegistry(SOL)", await getSplAssetRegistryAddress(SOL_MINT));
  await inspect("splAssetVault(SOL)", await getSplAssetVaultAddress(SOL_MINT));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
