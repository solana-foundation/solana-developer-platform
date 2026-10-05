#!/usr/bin/env node
import { safeHostname, selectHealthySolanaRpcUrl } from "../lib/solana-rpc-health.mjs";

try {
  const selected = await selectHealthySolanaRpcUrl(process.env);

  if (!selected) {
    console.error(
      "No SOLANA_RPC_<PROVIDER>_DEVNET_API_KEY_URL is configured; Surfpool must fork devnet."
    );
    process.exit(1);
  }

  console.error(
    `Using ${selected.id} Solana RPC for Surfpool remote (${safeHostname(selected.url)}).`
  );
  process.stdout.write(selected.url);
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Failed to select a Surfpool remote RPC: ${message.replaceAll(/[\r\n]/g, " ")}`);
  process.exit(1);
}
