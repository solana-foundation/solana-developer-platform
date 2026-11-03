import { z } from "zod";
import type { Command, Options } from "./commands";
import { type JsonObject, operationById } from "./contract";
import { usageError } from "./errors";

type Flag = Command["flags"][string];
const textFlag = (description: string) => ({ type: "string", description }) as const;
const flags = {
  provider: textFlag(
    "Exact custody provider; credential submission/rotation support Privy and Fireblocks"
  ),
  fields: textFlag(
    "Provider fields as a JSON object; prefer --data @file.json or stdin for credentials"
  ),
  "request-delay-ms": textFlag("Optional request delay in whole milliseconds (0–3000)"),
  "wallet-label": textFlag("Optional wallet label retained for installation"),
  "fireblocks-vault-account-ids": textFlag(
    "Selected Fireblocks vault IDs as a JSON string array (1–20); preserve IDs as strings"
  ),
  "api-user-id": textFlag("Fireblocks API user ID; separate from the SDP account --api-key"),
  "signing-key-id": textFlag("fbcsr_ ID from the API-generated CSR; never a private key"),
  after: textFlag("Opaque vault-discovery cursor returned as nextCursor"),
  "name-prefix": textFlag("Optional vault name prefix"),
  limit: textFlag("Connection count; the API defaults to 20 and clamps/truncates to 1–50"),
  offset: textFlag("Connection offset; the API clamps/truncates to its safe integer range"),
  "custody-wallet-id": textFlag(
    "Exact SDP custody wallet record ID for the Fireblocks destination check"
  ),
  "counterparty-id": textFlag("Destination counterparty ID"),
  "counterparty-account-id": textFlag("Destination counterparty account ID"),
  address: textFlag("Exact current contact address"),
  asset: textFlag("Token symbol or mint accepted by the Fireblocks destination check"),
} as const satisfies Record<string, Flag>;
type FlagName = keyof typeof flags;
function command(
  words: readonly string[],
  operationId: string,
  names: readonly FlagName[] = []
): Command {
  const operation = operationById(operationId);
  const commandFlags: Record<string, Flag> = Object.fromEntries(
    names.map((name) => [name, flags[name]])
  );
  if (operation.body !== null)
    commandFlags.data = textFlag(
      "Complete JSON object, @file.json, or - for stdin; use instead of body flags"
    );
  if (
    operation.parameters.some(
      (p) => p.location === "header" && p.name.toLowerCase() === "idempotency-key"
    )
  )
    commandFlags["idempotency-key"] = textFlag(
      "Required caller-chosen retry key; never generated automatically"
    );
  return { words: ["custody", ...words], operationId, flags: commandFlags };
}
const submission = [
  "provider",
  "fields",
  "request-delay-ms",
  "wallet-label",
  "fireblocks-vault-account-ids",
] as const;
export const custodyCommands: readonly Command[] = [
  command(["providers", "list"], "listCustodySetupProviders"),
  command(["connections", "list"], "listCustodySetupConnections", ["provider", "limit", "offset"]),
  command(["connections", "get"], "getCustodySetupConnection"),
  // biome-ignore lint/security/noSecrets: canonical OpenAPI operation ID, not a credential.
  command(["connections", "credential-lifecycle", "get"], "getCustodySetupCredentialLifecycle"),
  command(["connections", "replace-credentials"], "replaceCustodySetupCredentials", submission),
  command(["connections", "complete-installation"], "completeCustodySetupConnection"),
  command(["connections", "cancel-installation"], "cancelCustodySetupConnection"),
  command(["connections", "deactivate"], "deactivateCustodySetupConnection"),
  command(["credentials", "submit"], "submitCustodySetupCredentials", submission),
  command(["credentials", "rotate"], "rotateCustodySetupCredential", ["provider", "fields"]),
  command(["credentials", "complete-rotation"], "completeCustodySetupCredentialRotation"),
  // biome-ignore lint/security/noSecrets: canonical OpenAPI operation ID, not a credential.
  command(["credentials", "rollback-rotation"], "rollbackCustodySetupCredential"),
  command(["credentials", "deactivate"], "deactivateCustodySetupCredential"),
  command(["fireblocks", "csr", "get"], "getCustodyFireblocksCsr"),
  command(["fireblocks", "csr", "create"], "createCustodyFireblocksCsr"),
  // biome-ignore lint/security/noSecrets: canonical OpenAPI operation ID, not a credential.
  command(["fireblocks", "vaults", "discover"], "discoverCustodyFireblocksVaults", [
    "api-user-id",
    "signing-key-id",
    "after",
    "name-prefix",
  ]),
  // biome-ignore lint/security/noSecrets: canonical OpenAPI operation ID, not a credential.
  command(["fireblocks", "destination-eligibility", "get"], "getDashboardFireblocksDestination", [
    "custody-wallet-id",
    "counterparty-id",
    "counterparty-account-id",
    "address",
    "asset",
  ]),
  command(["wallets", "request-faucet"], "requestDashboardWalletFaucet"),
];
export const custodyOptionFields = {
  fields: z.string().optional(),
  "fireblocks-vault-account-ids": z.string().optional(),
  "api-user-id": z.string().optional(),
  "signing-key-id": z.string().optional(),
  after: z.string().optional(),
  "name-prefix": z.string().optional(),
  offset: z.coerce.number().optional(),
};
export const custodyQueryFields = [
  ["offset", "offset"],
  ["custody-wallet-id", "walletId"],
  ["counterparty-account-id", "accountId"],
  ["address", "address"],
] as const;
export function custodyBodyFromFlags(
  options: Options,
  parseObject: (text: string, label: string) => JsonObject
): JsonObject {
  const body: JsonObject = {};
  for (const [flag, field] of [
    ["provider", "provider"],
    ["request-delay-ms", "requestDelayMs"],
    ["wallet-label", "walletLabel"],
    ["api-user-id", "apiKey"],
    ["signing-key-id", "signingKeyId"],
    ["after", "after"],
    ["name-prefix", "namePrefix"],
  ] as const) {
    const value = options[flag];
    if (value !== undefined) body[field] = value;
  }
  if (options.fields !== undefined) body.fields = parseObject(options.fields, "--fields");
  if (options["fireblocks-vault-account-ids"] !== undefined) {
    try {
      body.fireblocksVaultAccountIds = z
        .array(z.string())
        .parse(JSON.parse(options["fireblocks-vault-account-ids"]));
    } catch {
      usageError("--fireblocks-vault-account-ids must be a JSON array of strings.");
    }
  }
  return body;
}
