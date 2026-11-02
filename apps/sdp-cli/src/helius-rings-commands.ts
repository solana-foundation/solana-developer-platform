import { z } from "zod";
import type { Command, Options } from "./commands";
import { type JsonObject, operationById } from "./contract";

type Flag = Command["flags"][string];
const textFlag = (description: string) => ({ type: "string", description }) as const;
const flags = {
  name: textFlag("Wallet name, custom-ring slug, zone name, or connection label"),
  "custody-wallet-id": textFlag("Connected SDP custody wallet ID to provision a Rings wallet"),
  "rings-wallet-id": textFlag(
    "Source Rings wallet record ID (hrw_), distinct from its custody wallet ID"
  ),
  "op-type": textFlag("shield, withdraw, transfer_registered, merge, ring_exit, or ring_entry"),
  mint: textFlag("Exact runtime mint identifier; no token or unit conversion is performed"),
  "amount-raw": textFlag("Positive u64 base-unit integer string; omit for merge"),
  to: textFlag("Withdrawal destination or canonical same-tenant recipient shielded address"),
  ring: textFlag(
    "Ring name; default pool when omitted, custom ring required for ring_entry/ring_exit"
  ),
  "client-nonce": textFlag(
    "Required caller-chosen intent nonce (1–128 characters); never generated automatically"
  ),
  "ring-program-id": textFlag("Pre-deployed custom ring program address"),
  confirmation: textFlag(
    "Exact wallet name acknowledging irreversible rekey and abandonment of old encrypted funds"
  ),
  signature: textFlag("Exact original signature to assert absent when voiding a signed failure"),
  kind: textFlag("Zone kind accepted by the API: treasury or public"),
  limit: textFlag("Maximum wallets or operation summaries to fetch (1–200); one request"),
  "solana-rpc-url": textFlag(
    "Keyed Solana RPC URL to store on the API; prefer --data @file or stdin"
  ),
  "indexer-url": textFlag("Keyed Photon indexer URL to store on the API"),
  "prover-url": textFlag("Prover URL to store on the API"),
  "ring-rpc-url": textFlag("Optional custom-ring RPC URL to store on the API"),
  "allow-insecure-http": textFlag(
    "true or false; HTTP is permitted only by a development API environment"
  ),
} as const satisfies Record<string, Flag>;
type FlagName = keyof typeof flags;
function command(
  words: readonly string[],
  operationId: string,
  names: readonly FlagName[] = []
): Command {
  const commandFlags: Record<string, Flag> = Object.fromEntries(
    names.map((name) => [name, flags[name]])
  );
  if (operationById(operationId).body !== null)
    commandFlags.data = textFlag(
      "Complete JSON object, @file.json, or - for stdin; use instead of body flags"
    );
  return { words: ["helius-rings", ...words], operationId, flags: commandFlags };
}
export const heliusRingsCommands: readonly Command[] = [
  command(["health"], "getHeliusRingsHealth"),
  command(["setup-status"], "getHeliusRingsSetupStatus"),
  command(["rings", "list"], "listHeliusRingsProjectRings"),
  command(["rings", "register-and-initialize"], "createHeliusRingsProjectRing", [
    "name",
    "ring-program-id",
  ]),
  command(["wallets", "list"], "listHeliusRingsWallets", ["limit"]),
  command(["wallets", "provision-identity"], "createHeliusRingsWallet", [
    "custody-wallet-id",
    "name",
  ]),
  command(["wallets", "get"], "getHeliusRingsWallet"),
  command(["wallets", "sync"], "syncHeliusRingsWallet"),
  command(["wallets", "identity", "rekey"], "rekeyHeliusRingsWallet", ["confirmation"]),
  command(["wallets", "identity", "get"], "getHeliusRingsWalletIdentity"),
  command(["wallets", "zones", "list"], "listHeliusRingsZones"),
  command(["wallets", "zones", "create"], "createHeliusRingsZone", ["name", "kind"]),
  command(["operations", "list"], "listHeliusRingsOperations", ["limit"]),
  command(["operations", "execute"], "createHeliusRingsOperation", [
    "rings-wallet-id",
    "op-type",
    "mint",
    "amount-raw",
    "to",
    "ring",
    "client-nonce",
  ]),
  command(["operations", "get"], "getHeliusRingsOperation"),
  command(["operations", "resume-execution"], "executeHeliusRingsOperation"),
  command(["operations", "retry"], "retryHeliusRingsOperation", ["client-nonce"]),
  // biome-ignore lint/security/noSecrets: canonical OpenAPI operation ID, not a credential.
  command(["operations", "recheck-signed-failure"], "recheckHeliusRingsOperation"),
  // biome-ignore lint/security/noSecrets: canonical OpenAPI operation ID, not a credential.
  command(["operations", "void-signed-failure"], "voidHeliusRingsOperation", ["signature"]),
  command(["connections", "list"], "listHeliusRingsConnections"),
  command(["connections", "create"], "createHeliusRingsConnection", [
    "name",
    "solana-rpc-url",
    "indexer-url",
    "prover-url",
    "ring-rpc-url",
    "allow-insecure-http",
  ]),
  command(["connections", "test"], "testHeliusRingsConnection"),
  // biome-ignore lint/security/noSecrets: canonical OpenAPI operation ID, not a credential.
  command(["connections", "make-default"], "makeDefaultHeliusRingsConnection"),
  command(["connections", "deactivate"], "deactivateHeliusRingsConnection"),
];
export const heliusRingsOptionFields = {
  "rings-wallet-id": z.string().optional(),
  "op-type": z.string().optional(),
  "amount-raw": z.string().optional(),
  ring: z.string().optional(),
  "client-nonce": z.string().optional(),
  "ring-program-id": z.string().optional(),
  confirmation: z.string().optional(),
  "solana-rpc-url": z.string().optional(),
  "indexer-url": z.string().optional(),
  "prover-url": z.string().optional(),
  "ring-rpc-url": z.string().optional(),
  "allow-insecure-http": z.enum(["true", "false"]).optional(),
};
export function heliusRingsBodyFromFlags(options: Options): JsonObject {
  const body: JsonObject = {};
  for (const [flag, field] of [
    ["name", "name"],
    ["custody-wallet-id", "walletId"],
    ["rings-wallet-id", "walletId"],
    ["op-type", "opType"],
    ["to", "to"],
    ["ring", "ring"],
    ["client-nonce", "clientNonce"],
    ["ring-program-id", "ringProgramId"],
    ["confirmation", "confirmation"],
    ["signature", "signature"],
    ["kind", "kind"],
    ["solana-rpc-url", "solanaRpcUrl"],
    ["indexer-url", "indexerUrl"],
    ["prover-url", "proverUrl"],
    ["ring-rpc-url", "ringRpcUrl"],
  ] as const) {
    const value = options[flag];
    if (value !== undefined) body[field] = value;
  }
  if (options.mint !== undefined || options["amount-raw"] !== undefined) {
    const asset: JsonObject = {};
    if (options.mint !== undefined) asset.mint = options.mint;
    if (options["amount-raw"] !== undefined) asset.amountRaw = options["amount-raw"];
    body.asset = asset;
  }
  if (options["allow-insecure-http"] !== undefined)
    body.allowInsecureHttp = options["allow-insecure-http"] === "true";
  return body;
}
