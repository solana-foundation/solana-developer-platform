import { z } from "zod";
import type { Command, Options } from "./commands";
import { type JsonObject, operationById } from "./contract";
import { usageError } from "./errors";

type Flag = Command["flags"][string];
const textFlag = (description: string) => ({ type: "string", description }) as const;
const flags = {
  "gateway-url": textFlag("SPC gateway URL"),
  "auth-url": textFlag("SPC auth service URL"),
  "chain-rpc-url": textFlag("Deprecated compatibility field; execution uses SDP's managed RPC"),
  "escrow-program-id": textFlag("Escrow program address"),
  "withdraw-program-id": textFlag("Withdrawal program address"),
  "escrow-instance-addr": textFlag("Escrow instance address"),
  "instance-id": textFlag("Exact active instance ID being updated"),
  "confirm-reactivate": textFlag(
    "true or false; explicitly acknowledge overwriting inactive configuration"
  ),
  name: textFlag("Channel or business-principal name"),
  description: textFlag("Channel description"),
  "wallet-id": {
    ...textFlag("Source connected custody wallet ID or public key; supply once"),
    multiple: true,
  },
  amount: textFlag(
    "Positive amount in token UI units as an exact decimal string (at most six fractional digits)"
  ),
  mint: textFlag("Token mint; omit to use the server's first allowed token"),
  recipient: textFlag("Deposit recipient wallet ID or address; defaults to the depositor"),
  destination: textFlag("Withdrawal release address; defaults to the owner"),
  "recipient-verified-wallet-id": textFlag(
    "Opaque verified-wallet ID from transfer-recipients; not a pubkey or principal ID"
  ),
  owner: textFlag("Balance owner: connected wallet ID, wallet public key, or raw Solana address"),
  "principal-id": textFlag("Project business principal ID; distinct from an SDP user or member"),
  "channel-id": textFlag("Optional channel ID filter for retained transfer history"),
  family: textFlag("Event family accepted by the API"),
  type: { ...textFlag("Exact event type; supply once"), multiple: true },
  status: textFlag("Exact event status"),
  limit: textFlag("Events per page (1–100); defaults stay on the server"),
  before: textFlag("Opaque nextCursor from a previous events response"),
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
      (parameter) =>
        parameter.location === "header" && parameter.name.toLowerCase() === "idempotency-key"
    )
  )
    commandFlags["idempotency-key"] = textFlag(
      "Required retry-stable key for this logical movement; no key is generated automatically"
    );
  return { words: ["private-channels", ...words], operationId, flags: commandFlags };
}
const instance = [
  "gateway-url",
  "auth-url",
  "chain-rpc-url",
  "escrow-program-id",
  "withdraw-program-id",
  "escrow-instance-addr",
] as const;
const movement = ["wallet-id", "amount", "mint"] as const;
const events = ["family", "type", "status", "limit", "before"] as const;
export const privateChannelsCommands: readonly Command[] = [
  command(["instance-connection", "get"], "getPrivateChannelInstance"),
  command(["instance-connection", "connect"], "connectPrivateChannelInstance", [
    ...instance,
    "confirm-reactivate",
  ]),
  command(["instance-connection", "update"], "updatePrivateChannelInstance", [
    ...instance,
    "instance-id",
  ]),
  command(["instance-connection", "disconnect"], "disconnectPrivateChannelInstance"),
  command(["instance-connection", "delete"], "deletePrivateChannelInstance"),
  command(["instance", "overview", "get"], "getPrivateChannelOverview"),
  command(["instance-connection", "probe"], "probePrivateChannelConnection", [
    "gateway-url",
    "auth-url",
    "escrow-program-id",
    "escrow-instance-addr",
  ]),
  command(["instance-connection", "check-gateway-health"], "getPrivateChannelHealth", [
    "gateway-url",
  ]),
  command(["balances", "get"], "getPrivateChannelBalance", ["owner", "mint"]),
  command(["token-eligibility", "list"], "listPrivateChannelTokenEligibility"),
  command(["deposits", "execute"], "createPrivateChannelDeposit", [...movement, "recipient"]),
  command(["deposits", "list"], "listPrivateChannelDeposits"),
  command(["deposits", "get"], "getPrivateChannelDeposit"),
  command(["withdrawals", "execute"], "createPrivateChannelWithdrawal", [
    ...movement,
    "destination",
  ]),
  command(["withdrawals", "list"], "listPrivateChannelWithdrawals"),
  command(["withdrawals", "get"], "getPrivateChannelWithdrawal"),
  command(["transfers", "execute"], "createPrivateChannelTransfer", [
    ...movement,
    "recipient-verified-wallet-id",
  ]),
  command(["transfers", "list"], "listPrivateChannelTransfers", ["channel-id"]),
  command(["transfers", "get"], "getPrivateChannelTransfer"),
  command(["channels", "list"], "listPrivateChannels"),
  command(["channels", "create"], "createPrivateChannel", ["name", "description"]),
  command(["channels", "get"], "getPrivateChannel"),
  command(["channels", "delete"], "deletePrivateChannel"),
  command(["channels", "transfer-recipients", "list"], "listPrivateChannelTransferRecipients"),
  command(["channels", "events", "list"], "listPrivateChannelEvents", events),
  // biome-ignore lint/security/noSecrets: canonical OpenAPI operation ID, not a credential.
  command(["channels", "principal-memberships", "add"], "addPrivateChannelPrincipalMembership", [
    "principal-id",
  ]),
  command(
    ["channels", "principal-memberships", "remove"],
    "removePrivateChannelPrincipalMembership"
  ),
  command(["events", "list"], "listProjectPrivateChannelEvents", events),
  command(["events", "reference-labels", "list"], "listPrivateChannelEventReferences"),
  command(["verified-wallets", "list"], "listPrivateChannelVerifiedWallets"),
  command(["wallets", "verify"], "verifyPrivateChannelWallet", ["principal-id"]),
  command(["verified-wallets", "revoke"], "deletePrivateChannelVerifiedWallet"),
  command(["principals", "list"], "listPrivateChannelPrincipals"),
  command(["principals", "create"], "createPrivateChannelPrincipal", ["name"]),
  command(["principals", "disable"], "disablePrivateChannelPrincipal"),
];
export const privateChannelsOptionFields = {
  "gateway-url": z.string().optional(),
  "auth-url": z.string().optional(),
  "chain-rpc-url": z.string().optional(),
  "escrow-program-id": z.string().optional(),
  "withdraw-program-id": z.string().optional(),
  "escrow-instance-addr": z.string().optional(),
  "instance-id": z.string().optional(),
  "confirm-reactivate": z.enum(["true", "false"]).optional(),
  recipient: z.string().optional(),
  "recipient-verified-wallet-id": z.string().optional(),
  owner: z.string().optional(),
  "principal-id": z.string().optional(),
  "channel-id": z.string().optional(),
  family: z.string().optional(),
  before: z.string().optional(),
};
export const privateChannelsQueryFields = [
  ["gateway-url", "gatewayUrl"],
  ["owner", "owner"],
  ["mint", "mint"],
  ["channel-id", "channelId"],
  ["family", "family"],
  ["before", "before"],
] as const;
export function privateChannelsBodyFromFlags(options: Options): JsonObject {
  const body: JsonObject = {};
  for (const [flag, field] of [
    ["gateway-url", "gatewayUrl"],
    ["auth-url", "authUrl"],
    ["chain-rpc-url", "chainRpcUrl"],
    ["escrow-program-id", "escrowProgramId"],
    ["withdraw-program-id", "withdrawProgramId"],
    ["escrow-instance-addr", "escrowInstanceAddr"],
    ["instance-id", "instanceId"],
    ["name", "name"],
    ["description", "description"],
    ["amount", "amount"],
    ["mint", "mint"],
    ["recipient", "recipient"],
    ["destination", "destination"],
    ["recipient-verified-wallet-id", "recipientVerifiedWalletId"],
    ["principal-id", "principalId"],
  ] as const) {
    const value = options[flag];
    if (value !== undefined) body[field] = value;
  }
  const walletIds = options["wallet-id"];
  if (walletIds !== undefined) {
    if (walletIds.length !== 1)
      usageError("Supply --wallet-id once for a Private Channels movement.");
    body.walletId = walletIds[0];
  }
  if (options["confirm-reactivate"] !== undefined)
    body.confirmReactivate = options["confirm-reactivate"] === "true";
  return body;
}
