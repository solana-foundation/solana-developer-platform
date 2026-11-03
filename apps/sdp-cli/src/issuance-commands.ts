import { z } from "zod";
import type { Command, Options } from "./commands";
import { type JsonObject, operationById } from "./contract";

type Flag = Command["flags"][string];
const textFlag = (description: string) => ({ type: "string", description }) as const;
const flags = {
  name: textFlag("Token name"),
  symbol: textFlag("Token symbol"),
  decimals: textFlag("Token decimals (0–18)"),
  description: textFlag("Token description; use JSON null to clear"),
  uri: textFlag("HTTP(S) token metadata URI; use JSON null to clear"),
  "image-url": textFlag("HTTP(S) token image URL; use JSON null to clear"),
  "max-supply": textFlag("Supply cap in token UI units as a decimal string; JSON null uncaps"),
  template: textFlag("Template ID; the server owns defaults and legacy aliases"),
  overrides: textFlag("Template overrides as a JSON object"),
  "signing-custody-wallet-id": textFlag("Exact SDP signing wallet record ID"),
  "signing-wallet-id": textFlag("Legacy provider wallet ID for caller-signed deploy preparation"),
  "requires-allowlist": textFlag("true or false; do not confuse false with omission"),
  mintable: textFlag("true or false; whether minting is enabled"),
  freezable: textFlag("true or false; whether freezing is enabled"),
  "fee-payment": textFlag("Fee-payment mode accepted by this operation"),
  "authority-wallets": textFlag("Deployment authority custody wallet IDs as a JSON object"),
  mint: textFlag("Mint request as JSON: destination, exact decimal-string amount, optional memo"),
  burn: textFlag("Burn request as JSON: source, exact decimal-string amount, optional memo"),
  seize: textFlag(
    "Seize request as JSON: source, destination, decimal-string amount, optional delegateAuthority/memo"
  ),
  "force-burn": textFlag(
    "Force-burn request as JSON: source, decimal-string amount, optional delegateAuthority/memo"
  ),
  authority: textFlag(
    "Authority request as JSON: role, nullable newAuthority, optional currentAuthority"
  ),
  options: textFlag(
    "Transaction options as JSON; explicit zero priority fees and false simulation values are preserved"
  ),
  signature: textFlag("Signature of the caller-submitted deployment transaction"),
  "mint-address": textFlag("Exact mint returned by deploy preparation"),
  "account-address": textFlag("Token account address to freeze or unfreeze"),
  reason: textFlag("Optional freeze reason"),
  address: textFlag("Allowlist wallet address"),
  label: textFlag("Allowlist label or exact list label filter"),
  "wallet-address": textFlag("Holder's wallet address"),
  "counterparty-id": textFlag("Optional holder counterparty ID"),
  "review-mode": textFlag("Holder review mode: auto or manual"),
  "asset-category": textFlag("Asset profile category"),
  "asset-type": textFlag("Asset type within the category"),
  "issuance-metadata": textFlag(
    "Complete issuanceMetadata JSON object; replaces the prior object on update"
  ),
  page: textFlag("Page number (1-based)"),
  "page-size": textFlag("Page size; the operation's generated schema sets its limit"),
  search: textFlag("Server-side contains search"),
  status: textFlag("Stored token or transaction lifecycle status"),
  type: { ...textFlag("Transaction type; repeat for cross-token history"), multiple: true },
  "deployment-status": textFlag("Derived deployment status"),
  "created-after": textFlag("Inclusive ISO creation-time lower bound"),
  "created-before": textFlag("Inclusive ISO creation-time upper bound"),
  "sort-by": textFlag("Token list sort field"),
  "sort-direction": textFlag("asc or desc"),
  "custody-wallet-id": textFlag("Exact SDP wallet record ID for participant history"),
  "wallet-id": {
    ...textFlag("Legacy provider wallet ID; supply once and omit --custody-wallet-id"),
    multiple: true,
  },
  action: textFlag("Audit action filter"),
  category: textFlag("Asset profile category filter"),
  "token-ids": textFlag("Comma-separated token IDs (up to 100)"),
  "include-archived": { type: "boolean", description: "Include archived profiles" },
  "include-allowlist-authority": textFlag(
    "true or false; opt in to allowlist-authority resolution"
  ),
  "include-freeze-authority": textFlag("true or false; opt in to freeze-authority resolution"),
  "include-metadata-authority": textFlag("true or false; opt in to metadata-authority resolution"),
  "include-pause-authority": textFlag("true or false; opt in to pause-authority resolution"),
} as const satisfies Record<string, Flag>;
type FlagName = keyof typeof flags;
const page = ["page", "page-size"] as const;
const create = [
  "name",
  "symbol",
  "decimals",
  "description",
  "uri",
  "image-url",
  "max-supply",
  "template",
  "overrides",
  "signing-custody-wallet-id",
  "requires-allowlist",
  "mintable",
  "freezable",
] as const;
const update = [
  "name",
  "symbol",
  "decimals",
  "description",
  "uri",
  "image-url",
  "max-supply",
  "signing-custody-wallet-id",
  "requires-allowlist",
] as const;
const profile = ["asset-category", "asset-type", "issuance-metadata"] as const;
const tx = ["signing-custody-wallet-id", "options"] as const;
function command(
  words: readonly string[],
  operationId: string,
  names: readonly FlagName[]
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
      (parameter) =>
        parameter.location === "header" && parameter.name.toLowerCase() === "idempotency-key"
    )
  )
    commandFlags["idempotency-key"] = textFlag(
      "Explicit retry-stable key for this logical operation; no key is generated automatically"
    );
  return { words, operationId, flags: commandFlags };
}
const tokenCommand = (words: readonly string[], operationId: string, names: readonly FlagName[]) =>
  command(["issuance", "tokens", ...words], operationId, names);
export const issuanceCommands: readonly Command[] = [
  command(["issuance", "templates", "list"], "listTokenTemplates", []),
  command(["issuance", "templates", "get"], "getTokenTemplate", []),
  tokenCommand(["create"], "createToken", create),
  tokenCommand(["list"], "listTokens", [
    ...page,
    "search",
    "status",
    "deployment-status",
    "template",
    "created-after",
    "created-before",
    "sort-by",
    "sort-direction",
  ]),
  tokenCommand(["facets"], "listTokenFacets", []),
  tokenCommand(["get"], "getToken", [
    "include-allowlist-authority",
    "include-freeze-authority",
    "include-metadata-authority",
    "include-pause-authority",
  ]),
  tokenCommand(["update"], "updateToken", update),
  tokenCommand(["metadata", "get"], "getTokenMetadataJson", []),
  tokenCommand(["refresh-supply"], "refreshTokenSupply", []),
  command(["issuance", "transactions", "list"], "listIssuanceTransactions", [
    ...page,
    "type",
    "status",
    "custody-wallet-id",
    "wallet-id",
  ]),
  command(["issuance", "tokens", "transactions", "list"], "listTokenTransactions", [
    ...page,
    "type",
    "status",
  ]),
  tokenCommand(["audit-history", "list"], "getAssetAuditHistory", [...page, "action"]),
  tokenCommand(["deploy", "execute"], "deployToken", [
    "signing-custody-wallet-id",
    "authority-wallets",
    "fee-payment",
  ]),
  tokenCommand(["deploy", "build-unsigned-transaction"], "prepareDeployToken", [
    "signing-wallet-id",
    "fee-payment",
  ]),
  tokenCommand(["deploy", "confirm-submitted-transaction"], "confirmDeploy", [
    "signature",
    "mint-address",
  ]),
  tokenCommand(["deploy", "metadata", "build-unsigned-transaction"], "prepareDeployMetadata", []),
  tokenCommand(["mint", "execute"], "executeMint", [...tx, "mint"]),
  tokenCommand(["mint", "build-unsigned-transaction"], "prepareMint", [...tx, "mint"]),
  tokenCommand(["burn", "execute"], "executeBurn", [...tx, "burn"]),
  tokenCommand(["burn", "build-unsigned-transaction"], "prepareBurn", [...tx, "burn"]),
  tokenCommand(["seize", "execute"], "executeSeize", [...tx, "seize"]),
  tokenCommand(["seize", "build-unsigned-transaction"], "prepareSeize", [...tx, "seize"]),
  tokenCommand(["force-burn", "execute"], "executeForceBurn", [...tx, "force-burn"]),
  tokenCommand(["force-burn", "build-unsigned-transaction"], "prepareForceBurn", [
    ...tx,
    "force-burn",
  ]),
  tokenCommand(["authority", "update", "execute"], "executeUpdateAuthority", [...tx, "authority"]),
  tokenCommand(["authority", "update", "build-unsigned-transaction"], "prepareUpdateAuthority", [
    ...tx,
    "authority",
  ]),
  tokenCommand(["pause"], "pauseToken", tx),
  tokenCommand(["unpause"], "unpauseToken", tx),
  tokenCommand(["freeze-account"], "freezeAccount", [
    "signing-custody-wallet-id",
    "account-address",
    "reason",
  ]),
  tokenCommand(["unfreeze-account"], "unfreezeAccount", [
    "signing-custody-wallet-id",
    "account-address",
  ]),
  command(["issuance", "tokens", "frozen-accounts", "list"], "listFrozenAccounts", page),
  command(["issuance", "tokens", "control-list", "list"], "listTokenAllowlist", [
    ...page,
    "search",
    "label",
  ]),
  command(["issuance", "tokens", "control-list", "labels", "list"], "listTokenAllowlistLabels", []),
  command(["issuance", "tokens", "control-list", "add"], "addTokenAllowlistEntry", [
    "signing-custody-wallet-id",
    "address",
    "label",
  ]),
  command(["issuance", "tokens", "control-list", "remove"], "removeTokenAllowlistEntry", [
    "signing-custody-wallet-id",
  ]),
  command(["issuance", "tokens", "holder-enrollments", "list"], "listHolders", page),
  command(["issuance", "tokens", "holder-enrollments", "create"], "enrollHolder", [
    "wallet-address",
    "counterparty-id",
    "review-mode",
  ]),
  command(["asset-profiles", "field-options", "get"], "getAssetProfileFieldOptions", []),
  command(["asset-profiles", "list"], "listAssetProfiles", [
    ...page,
    "include-archived",
    "category",
    "token-ids",
  ]),
  command(["issuance", "tokens", "create-with-asset-profile"], "createTokenWithAssetProfile", [
    ...create,
    ...profile,
  ]),
  command(["asset-profiles", "get"], "getAssetProfile", []),
  // biome-ignore lint/security/noSecrets: canonical OpenAPI operation ID, not a credential.
  command(["asset-profiles", "get-by-token"], "getAssetProfileByToken", []),
  command(["asset-profiles", "update"], "updateAssetProfile", profile),
  command(["asset-profiles", "archive"], "archiveAssetProfile", []),
];

export const issuanceOptionFields = {
  symbol: z.string().optional(),
  decimals: z.coerce.number().optional(),
  uri: z.string().optional(),
  "image-url": z.string().optional(),
  "max-supply": z.string().optional(),
  template: z.string().optional(),
  overrides: z.string().optional(),
  "signing-custody-wallet-id": z.string().optional(),
  "signing-wallet-id": z.string().optional(),
  "requires-allowlist": z.enum(["true", "false"]).optional(),
  mintable: z.enum(["true", "false"]).optional(),
  freezable: z.enum(["true", "false"]).optional(),
  "fee-payment": z.string().optional(),
  "authority-wallets": z.string().optional(),
  mint: z.string().optional(),
  burn: z.string().optional(),
  seize: z.string().optional(),
  "force-burn": z.string().optional(),
  authority: z.string().optional(),
  signature: z.string().optional(),
  "mint-address": z.string().optional(),
  "account-address": z.string().optional(),
  reason: z.string().optional(),
  address: z.string().optional(),
  "wallet-address": z.string().optional(),
  "review-mode": z.string().optional(),
  "asset-category": z.string().optional(),
  "asset-type": z.string().optional(),
  "issuance-metadata": z.string().optional(),
  "deployment-status": z.string().optional(),
  "created-after": z.string().optional(),
  "created-before": z.string().optional(),
  action: z.string().optional(),
  "token-ids": z.string().optional(),
  "include-allowlist-authority": z.enum(["true", "false"]).optional(),
  "include-freeze-authority": z.enum(["true", "false"]).optional(),
  "include-metadata-authority": z.enum(["true", "false"]).optional(),
  "include-pause-authority": z.enum(["true", "false"]).optional(),
};
export const issuanceQueryFields = [
  ["template", "template"],
  ["deployment-status", "deploymentStatus"],
  ["created-after", "createdAfter"],
  ["created-before", "createdBefore"],
  ["action", "action"],
  ["signing-custody-wallet-id", "signingCustodyWalletId"],
  ["token-ids", "tokenIds"],
  ["include-allowlist-authority", "includeAllowlistAuthority"],
  ["include-freeze-authority", "includeFreezeAuthority"],
  ["include-metadata-authority", "includeMetadataAuthority"],
  ["include-pause-authority", "includePauseAuthority"],
  ["label", "label"],
] as const;

export function issuanceBodyFromFlags(
  options: Options,
  parseObject: (value: string, label: string) => JsonObject
): JsonObject {
  const body: JsonObject = {};
  for (const [flag, field] of [
    ["name", "name"],
    ["symbol", "symbol"],
    ["decimals", "decimals"],
    ["description", "description"],
    ["uri", "uri"],
    ["image-url", "imageUrl"],
    ["max-supply", "maxSupply"],
    ["template", "template"],
    ["signing-custody-wallet-id", "signingCustodyWalletId"],
    ["signing-wallet-id", "signingWalletId"],
    ["fee-payment", "feePayment"],
    ["signature", "signature"],
    ["mint-address", "mint"],
    ["account-address", "accountAddress"],
    ["reason", "reason"],
    ["address", "address"],
    ["label", "label"],
    ["wallet-address", "walletAddress"],
    ["counterparty-id", "counterpartyId"],
    ["review-mode", "reviewMode"],
    ["asset-category", "assetCategory"],
    ["asset-type", "assetType"],
  ] as const) {
    const value = options[flag];
    if (value !== undefined) body[field] = value;
  }
  for (const [flag, field] of [
    ["requires-allowlist", "requiresAllowlist"],
    ["mintable", "isMintable"],
    ["freezable", "isFreezable"],
  ] as const) {
    if (options[flag] !== undefined) body[field] = options[flag] === "true";
  }
  for (const [flag, field] of [
    ["overrides", "overrides"],
    ["authority-wallets", "authorityCustodyWalletIds"],
    ["mint", "mint"],
    ["burn", "burn"],
    ["seize", "seize"],
    ["force-burn", "forceBurn"],
    ["authority", "authority"],
    ["options", "options"],
    ["issuance-metadata", "issuanceMetadata"],
  ] as const) {
    const value = options[flag];
    if (value !== undefined) body[field] = parseObject(value, `--${flag}`);
  }
  return body;
}
