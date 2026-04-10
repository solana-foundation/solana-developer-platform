import { spawn } from "node:child_process";
import { safeHostname, selectHealthySolanaRpcUrl } from "./lib/solana-rpc-health.mjs";

const [command, ...args] = process.argv.slice(2);

if (!command) {
  console.error("Usage: node scripts/run-with-healthy-solana-rpc.mjs <command> [...args]");
  process.exit(1);
}

try {
  const env = { ...process.env };
  const selected = await selectHealthySolanaRpcUrl(env);

  if (selected) {
    env.SOLANA_RPC_URL = selected.url;
    env.SOLANA_RPC_DEFAULT_PROVIDER = "default";
    console.log(`Using ${selected.id} Solana RPC (${safeHostname(selected.url)}).`);
  }

  const code = await run(command, args, env);
  process.exit(code);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}

function run(command, args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: "inherit",
      env,
    });

    child.on("error", reject);
    child.on("exit", (code, signal) => {
      if (signal) {
        reject(new Error(`Command terminated by signal ${signal}`));
        return;
      }

      resolve(code ?? 1);
    });
  });
}
