import type { ParseArgsConfig } from "node:util";
import { API_KEY_WALLET_SCOPES, SDP_ENVIRONMENTS } from "@sdp/types/api-keys";
import { COUNTERPARTY_ACCOUNT_KINDS, COUNTERPARTY_ENTITY_TYPES } from "@sdp/types/counterparties";
import { COUNTRY_CODES } from "@sdp/types/countries";
import { DVP_TRADE_SIDES } from "@sdp/types/dvp";
import { EARN_MOVEMENT_DIRECTIONS } from "@sdp/types/earn";
import { RAMP_DIRECTIONS } from "@sdp/types/payments";
import { ORGANIZATION_ROLES } from "@sdp/types/roles";
import {
  UNIFIED_TRANSACTION_MODULES,
  UNIFIED_TRANSACTION_STATUSES,
} from "@sdp/types/unified-transactions";
import { z } from "zod";
import { type JsonObject, operationById, type QueryValue } from "./contract";
import {
  custodyBodyFromFlags,
  custodyCommands,
  custodyOptionFields,
  custodyQueryFields,
} from "./custody-commands";
import { discoveryCommands, discoveryOptionFields } from "./discovery-commands";
import { earnBodyFields, earnCommands, earnOptionFields, earnQueryFields } from "./earn-commands";
import { usageError } from "./errors";
import {
  heliusRingsBodyFromFlags,
  heliusRingsCommands,
  heliusRingsOptionFields,
} from "./helius-rings-commands";
import {
  issuanceBodyFromFlags,
  issuanceCommands,
  issuanceOptionFields,
  issuanceQueryFields,
} from "./issuance-commands";
import {
  placesBodyFromFlags,
  placesCommands,
  placesOptionFields,
  placesQueryFields,
} from "./places-commands";
import {
  privateChannelsBodyFromFlags,
  privateChannelsCommands,
  privateChannelsOptionFields,
  privateChannelsQueryFields,
} from "./private-channels-commands";
import { webhookCommands, webhookOptionFields } from "./webhook-input";

interface Flag {
  type: "string" | "boolean";
  multiple?: boolean;
  short?: string;
  description: string;
}

export const globalFlags = {
  help: { type: "boolean", short: "h", description: "Show command help" },
  version: { type: "boolean", short: "V", description: "Show CLI version" },
  "api-url": { type: "string", description: "API origin or base path (SDP_API_URL)" },
  "api-key": { type: "string", description: "API key (prefer SDP_API_KEY)" },
  token: { type: "string", description: "Clerk session token (prefer SDP_TOKEN)" },
  project: { type: "string", description: "Default project ID (SDP_PROJECT_ID)" },
  organization: { type: "string", description: "Default organization ID (SDP_ORGANIZATION_ID)" },
  "timeout-ms": {
    type: "string",
    description: "Request timeout in ms (SDP_TIMEOUT_MS; default 30000)",
  },
  json: { type: "boolean", description: "JSON output (the default)" },
  compact: { type: "boolean", description: "Print JSON without indentation" },
} as const satisfies Record<string, Flag>;

const dataFlags = {
  data: { type: "string", description: "JSON object, @file.json, or - for stdin" },
} as const satisfies Record<string, Flag>;

const namedBodyFlags = {
  ...dataFlags,
  name: { type: "string", description: "Name" },
} as const satisfies Record<string, Flag>;

const idempotencyFlags = {
  "idempotency-key": {
    type: "string",
    description: "Explicit key for a mutating request; reuse it when retrying the same operation",
  },
} as const satisfies Record<string, Flag>;

const roleFlags = {
  ...dataFlags,
  role: { type: "string", description: `Organization role: ${ORGANIZATION_ROLES.join(", ")}` },
} as const satisfies Record<string, Flag>;

const bodyFlags = {
  ...namedBodyFlags,
  description: { type: "string", description: "Description" },
} as const satisfies Record<string, Flag>;

const providerFlags = {
  provider: { type: "string", description: "Custody provider identifier" },
} as const satisfies Record<string, Flag>;

const walletIdFlags = {
  // API-key commands accept many signing wallets; wallet operations require
  // exactly one provider wallet ID, checked before constructing the request.
  "wallet-id": {
    type: "string",
    multiple: true,
    description: "Exact provider wallet ID (supply once)",
  },
} as const satisfies Record<string, Flag>;

const apiKeyFlags = {
  ...bodyFlags,
  grant: {
    type: "string",
    multiple: true,
    description: "Explicit module.verb grant (repeatable; replaces the grants on update)",
  },
  "wallet-scope": {
    type: "string",
    description: `Wallet scope: ${API_KEY_WALLET_SCOPES.join(", ")}`,
  },
  "wallet-id": {
    type: "string",
    multiple: true,
    description: "SDP custody wallet ID (repeatable)",
  },
  "allowed-ip": {
    type: "string",
    multiple: true,
    description: "IP address or CIDR (repeatable; replaces the allowlist on update)",
  },
  "expires-at": { type: "string", description: "Expiration as an ISO 8601 timestamp" },
} as const satisfies Record<string, Flag>;

const paginationFlags = {
  page: { type: "string", description: "Page number (1-based)" },
  "page-size": { type: "string", description: "Items per page (1–100)" },
} as const satisfies Record<string, Flag>;

const counterpartyFlags = {
  ...dataFlags,
  "entity-type": { type: "string", description: "individual or business" },
  "display-name": { type: "string", description: "Searchable counterparty display name" },
  "external-id": { type: "string", description: "Opaque external identifier" },
} as const satisfies Record<string, Flag>;

const counterpartyAccountFlags = {
  ...dataFlags,
  label: { type: "string", description: "Account display label" },
  details: { type: "string", description: "Complete account details as a JSON object" },
  "provider-account-data": { type: "string", description: "Provider metadata as a JSON object" },
} as const satisfies Record<string, Flag>;

const rampProviderFlags = {
  provider: { type: "string", description: "Ramp provider identifier accepted by this operation" },
} as const satisfies Record<string, Flag>;

const rampEstimateFlags = {
  ...dataFlags,
  "asset-rail": { type: "string", description: "Crypto rail, for example usdc.solana" },
  "fiat-currency": { type: "string", description: "Fiat currency code, for example USD" },
} as const satisfies Record<string, Flag>;

const rampQuoteFlags = {
  ...rampEstimateFlags,
  ...rampProviderFlags,
  "counterparty-id": { type: "string", description: "Counterparty owning the provider checkout" },
  "ramps-memo": {
    type: "string",
    description: "Ramp correlation metadata as a JSON object of strings",
  },
} as const satisfies Record<string, Flag>;

const rampTransferFlags = {
  ...dataFlags,
  "transfer-id": { type: "string", description: "SDP ramp transfer record ID" },
} as const satisfies Record<string, Flag>;

const directionFlags = {
  direction: { type: "string", description: "onramp or offramp" },
} as const satisfies Record<string, Flag>;

const paymentSourceFlags = {
  "source-custody-wallet-id": {
    type: "string",
    description: "Exact source SDP wallet record ID (id from wallets list)",
  },
  asset: { type: "string", description: "Payment token symbol or SPL mint address" },
} as const satisfies Record<string, Flag>;

const transferBatchFlags = {
  ...dataFlags,
  ...paymentSourceFlags,
  "external-id": {
    type: "string",
    description: "Batch correlation ID; independent of the idempotency key",
  },
  recipients: {
    type: "string",
    description: "JSON array of counterparty-account recipients and decimal-string amounts (1–500)",
  },
  options: {
    type: "string",
    description: "Batch options as JSON (chunk size, priority fee, preflight)",
  },
} as const satisfies Record<string, Flag>;

const recurringTermsFlags = {
  ...dataFlags,
  ...paymentSourceFlags,
  "counterparty-id": { type: "string", description: "Destination counterparty ID" },
  "counterparty-account-id": {
    type: "string",
    description: "Destination counterparty crypto-wallet account ID",
  },
  amount: {
    type: "string",
    description: "Positive amount in token UI units as an exact decimal string",
  },
  "period-hours": { type: "string", description: "Billing period in whole hours (1–8760)" },
  "first-collection-at": {
    type: "string",
    description: "Future ISO timestamp for the pending schedule's first collection",
  },
  "metadata-uri": {
    type: "string",
    description: "HTTP(S) plan metadata URI (up to 128 characters)",
  },
} as const satisfies Record<string, Flag>;

const planMutableFlags = {
  ...dataFlags,
  "plan-pda": { type: "string", description: "On-chain subscription plan PDA" },
  "destination-address": { type: "string", description: "Allowed destination owner address" },
  "puller-wallet-id": {
    type: "string",
    description: "Provider wallet ID allowed to collect payments",
  },
  "metadata-uri": {
    type: "string",
    description: "HTTP(S) plan metadata URI (up to 128 characters)",
  },
  status: { type: "string", description: "Subscription plan status accepted by the API" },
} as const satisfies Record<string, Flag>;

export const optionSchema = z
  .object({
    ...earnOptionFields,
    ...issuanceOptionFields,
    ...privateChannelsOptionFields,
    ...heliusRingsOptionFields,
    ...placesOptionFields,
    ...custodyOptionFields,
    ...webhookOptionFields,
    ...discoveryOptionFields,
    help: z.boolean().optional(),
    version: z.boolean().optional(),
    "api-url": z.string().optional(),
    "api-key": z.string().optional(),
    token: z.string().optional(),
    project: z.string().optional(),
    organization: z.string().optional(),
    "default-environment": z.enum(SDP_ENVIRONMENTS).optional(),
    "country-code": z.enum(COUNTRY_CODES).optional(),
    "terms-version": z.string().optional(),
    "accept-terms": z.enum(["true", "false"]).optional(),
    "clear-allowed-ips": z.boolean().optional(),
    "timeout-ms": z.string().optional(),
    json: z.boolean().optional(),
    compact: z.boolean().optional(),
    "include-archived": z.boolean().optional(),
    page: z.coerce.number().optional(),
    "page-size": z.coerce.number().optional(),
    email: z.string().optional(),
    role: z.enum(ORGANIZATION_ROLES).optional(),
    "idempotency-key": z.string().optional(),
    data: z.string().optional(),
    name: z.string().optional(),
    description: z.string().optional(),
    settings: z.string().optional(),
    "clear-description": z.boolean().optional(),
    "clear-settings": z.boolean().optional(),
    grant: z.array(z.string()).optional(),
    "wallet-scope": z.enum(API_KEY_WALLET_SCOPES).optional(),
    "wallet-id": z.array(z.string()).optional(),
    "allowed-ip": z.array(z.string()).optional(),
    "expires-at": z.string().optional(),
    "clear-expiration": z.boolean().optional(),
    "clear-grants": z.boolean().optional(),
    "grace-period-hours": z.coerce.number().optional(),
    confirmation: z.string().optional(),
    "cancel-recurring-payments": z.boolean().optional(),
    provider: z.string().optional(),
    "connection-id": z.string().optional(),
    label: z.string().optional(),
    "clear-label": z.boolean().optional(),
    purpose: z.string().optional(),
    "wallet-label": z.string().optional(),
    "request-delay-ms": z.coerce.number().optional(),
    network: z.string().optional(),
    intent: z.string().optional(),
    "account-policy": z.string().optional(),
    "include-balances": z.boolean().optional(),
    "include-balance": z.enum(["true", "false"]).optional(),
    view: z.literal("summary").optional(),
    "entity-type": z.enum(COUNTERPARTY_ENTITY_TYPES).optional(),
    "display-name": z.string().optional(),
    "external-id": z.string().optional(),
    "clear-external-id": z.boolean().optional(),
    "account-kind": z.enum(COUNTERPARTY_ACCOUNT_KINDS).optional(),
    details: z.string().optional(),
    "provider-account-data": z.string().optional(),
    direction: z
      .enum([...RAMP_DIRECTIONS, ...EARN_MOVEMENT_DIRECTIONS, "inbound", "outbound"])
      .optional(),
    "asset-rail": z.string().optional(),
    "fiat-currency": z.string().optional(),
    source: z.string().optional(),
    dest: z.string().optional(),
    "fiat-amount": z.string().optional(),
    "crypto-amount": z.string().optional(),
    "ramps-memo": z.string().optional(),
    "destination-custody-wallet-id": z.string().optional(),
    "destination-country": z.enum(COUNTRY_CODES).optional(),
    type: z.array(z.string()).optional(),
    search: z.string().optional(),
    "party-a": z.string().optional(),
    "party-b": z.string().optional(),
    "mint-a": z.string().optional(),
    "mint-b": z.string().optional(),
    "token-program-a": z.string().optional(),
    "token-program-b": z.string().optional(),
    "amount-a": z.string().optional(),
    "amount-b": z.string().optional(),
    "expiry-timestamp": z.string().optional(),
    "earliest-settlement-timestamp": z.string().optional(),
    "user-a-settlement-destination": z.string().optional(),
    "user-b-settlement-destination": z.string().optional(),
    "ref-string": z.string().optional(),
    side: z.enum(DVP_TRADE_SIDES).optional(),
    "settlement-availability": z.string().optional(),
    module: z.enum(UNIFIED_TRANSACTION_MODULES).optional(),
    kind: z.string().optional(),
    cursor: z.string().optional(),
    limit: z.coerce.number().optional(),
    ids: z.string().optional(),
    "source-custody-wallet-id": z.string().optional(),
    "custody-wallet-id": z.string().optional(),
    destination: z.string().optional(),
    asset: z.string().optional(),
    amount: z.string().optional(),
    memo: z.string().optional(),
    "transfer-id": z.string().optional(),
    recipients: z.string().optional(),
    options: z.string().optional(),
    status: z.string().optional(),
    category: z.string().optional(),
    "counterparty-id": z.string().optional(),
    "provider-reference": z.string().optional(),
    from: z.string().optional(),
    to: z.string().optional(),
    "include-observed": z.enum(["true", "false"]).optional(),
    "sort-by": z.string().optional(),
    "sort-direction": z.string().optional(),
    account: z.string().optional(),
    "counterparty-account-id": z.string().optional(),
    "period-hours": z.coerce.number().optional(),
    "first-collection-at": z.string().optional(),
    "next-collection-due-at": z.string().optional(),
    "metadata-uri": z.string().optional(),
    "clear-first-collection-at": z.boolean().optional(),
    "clear-next-collection-due-at": z.boolean().optional(),
    "clear-metadata-uri": z.boolean().optional(),
    "owner-wallet-id": z.string().optional(),
    "program-plan-id": z.string().optional(),
    "plan-pda": z.string().optional(),
    "destination-address": z.string().optional(),
    "puller-wallet-id": z.string().optional(),
    "clear-plan-pda": z.boolean().optional(),
    "clear-destination-address": z.boolean().optional(),
    "clear-puller-wallet-id": z.boolean().optional(),
    destinations: z.string().optional(),
    pullers: z.string().optional(),
    "end-ts": z.string().optional(),
    "plan-id": z.string().optional(),
    "subscriber-address": z.string().optional(),
    "subscriber-token-account": z.string().optional(),
    "expected-plan-created-at": z.string().optional(),
    "expected-subscription-authority-init-id": z.string().optional(),
    "receiver-token-account": z.string().optional(),
    "due-before": z.string().optional(),
    "minimum-slot": z
      .string()
      .regex(/^(0|[1-9]\d*)$/)
      .refine((value) => Number.isSafeInteger(Number(value)), "Slot must fit a safe integer")
      .optional(),
  })
  .strict();
export type Options = z.infer<typeof optionSchema>;

export interface Command {
  words: readonly string[];
  operationId: string;
  flags: Record<string, Flag>;
}

const dvpLegFlags = {
  ...dataFlags,
  ...idempotencyFlags,
  side: { type: "string", description: "Trade leg: a or b" },
  "custody-wallet-id": {
    type: "string",
    description: "Optional exact SDP wallet record ID; must hold this leg's party address",
  },
} as const satisfies Record<string, Flag>;

export const commands = [
  ...earnCommands,
  ...issuanceCommands,
  ...privateChannelsCommands,
  ...heliusRingsCommands,
  ...placesCommands,
  ...custodyCommands,
  ...webhookCommands,
  ...discoveryCommands,
  { words: ["onboarding", "status", "get"], operationId: "getOnboardingStatus", flags: {} },
  {
    words: ["wallets", "balances", "get"],
    operationId: "getPaymentWalletBalances",
    flags: {
      "minimum-slot": {
        type: "string",
        description:
          "Optional confirmed-state lower bound, a canonical integer from 0 to 9007199254740991; sent unchanged",
      },
    },
  },
  {
    words: ["network", "snapshot", "get"],
    // biome-ignore lint/security/noSecrets: canonical OpenAPI operation ID, not a credential.
    operationId: "getDashboardNetworkSnapshot",
    flags: {},
  },
  {
    words: ["compliance", "screen-address"],
    operationId: "screenComplianceAddress",
    flags: {
      ...dataFlags,
      ...idempotencyFlags,
      address: {
        type: "string",
        description: "Address to screen; Solana address validation is performed by the API",
      },
      network: {
        type: "string",
        description: "Provider network identifier; omitted uses the server default of solana",
      },
      intent: {
        type: "string",
        description:
          "transfer_destination, wallet_address_addition, or unknown; omitted uses the server default",
      },
    },
  },
  { words: ["dvp", "mints", "inspect"], operationId: "inspectDvpMint", flags: {} },
  {
    words: ["dvp", "trades", "create"],
    operationId: "createDvpTrade",
    flags: {
      ...dataFlags,
      ...idempotencyFlags,
      "party-a": {
        type: "string",
        description:
          "Party A JSON object with exactly one walletId (SDP record ID), counterpartyAccountId, or address",
      },
      "party-b": {
        type: "string",
        description:
          "Party B JSON object with exactly one walletId (SDP record ID), counterpartyAccountId, or address",
      },
      "mint-a": { type: "string", description: "Leg A token mint address" },
      "mint-b": { type: "string", description: "Leg B token mint address" },
      "token-program-a": { type: "string", description: "Token program owning leg A's mint" },
      "token-program-b": { type: "string", description: "Token program owning leg B's mint" },
      "amount-a": { type: "string", description: "Leg A raw base units as a u64 integer string" },
      "amount-b": { type: "string", description: "Leg B raw base units as a u64 integer string" },
      "expiry-timestamp": { type: "string", description: "Expiry Unix seconds as an i64 string" },
      "earliest-settlement-timestamp": {
        type: "string",
        description: "Optional earliest settlement Unix seconds as an i64 string",
      },
      "user-a-settlement-destination": {
        type: "string",
        description: "Optional party A settlement destination address",
      },
      "user-b-settlement-destination": {
        type: "string",
        description: "Optional party B settlement destination address",
      },
      "ref-string": {
        type: "string",
        description: "Optional client correlation reference; never proof of origin",
      },
    },
  },
  {
    words: ["dvp", "trades", "list"],
    operationId: "listDvpTrades",
    flags: {
      limit: {
        type: "string",
        description: "Newest matching trades (1–100); omitted uses the server default of 25",
      },
      status: { type: "string", description: "Comma-separated trade statuses" },
      "settlement-availability": {
        type: "string",
        description: "Comma-separated settlement availability values",
      },
      search: {
        type: "string",
        description: "Case-insensitive substring search; blank or 2–100 characters",
      },
    },
  },
  // biome-ignore lint/security/noSecrets: canonical OpenAPI operation ID, not a credential.
  { words: ["dvp", "trades", "inbound", "list"], operationId: "listInboundDvpTrades", flags: {} },
  { words: ["dvp", "trades", "get"], operationId: "getDvpTrade", flags: {} },
  { words: ["dvp", "trades", "fund"], operationId: "fundDvpTrade", flags: dvpLegFlags },
  { words: ["dvp", "trades", "reclaim"], operationId: "reclaimDvpTrade", flags: dvpLegFlags },
  {
    words: ["dvp", "trades", "settle"],
    operationId: "settleDvpTrade",
    flags: { ...idempotencyFlags },
  },
  {
    words: ["dvp", "trades", "cancel"],
    operationId: "cancelDvpTrade",
    flags: { ...idempotencyFlags },
  },
  {
    words: ["projects", "list"],
    operationId: "listProjects",
    flags: {
      "include-archived": { type: "boolean", description: "Include archived projects" },
    },
  },
  { words: ["projects", "get"], operationId: "getProject", flags: {} },
  {
    words: ["projects", "update"],
    operationId: "updateProject",
    flags: {
      ...bodyFlags,
      settings: { type: "string", description: "Settings as a JSON object" },
      "clear-description": { type: "boolean", description: "Set description to null" },
      "clear-settings": { type: "boolean", description: "Set settings to null" },
      ...idempotencyFlags,
    },
  },
  {
    words: ["projects", "provider-availability", "get"],
    operationId: "getProjectProviderAvailability",
    flags: {},
  },
  {
    words: ["projects", "members", "list"],
    operationId: "listProjectMembers",
    flags: {},
  },
  {
    words: ["projects", "api-keys", "list"],
    operationId: "listProjectApiKeys",
    flags: {},
  },
  {
    words: ["projects", "api-keys", "create"],
    operationId: "createProjectApiKey",
    flags: { ...apiKeyFlags },
  },
  {
    words: ["organizations", "create"],
    operationId: "createOrganization",
    flags: { ...namedBodyFlags },
  },
  { words: ["organizations", "get"], operationId: "getOrganization", flags: {} },
  {
    words: ["organizations", "update"],
    operationId: "updateOrganization",
    flags: {
      ...namedBodyFlags,
      settings: { type: "string", description: "Organization settings as a JSON object" },
      "default-environment": { type: "string", description: "sandbox or production" },
      "allowed-ip": {
        type: "string",
        multiple: true,
        description: "Replace the organization IP allowlist (repeatable)",
      },
      "clear-allowed-ips": {
        type: "boolean",
        description: "Set the organization IP allowlist to an empty array",
      },
    },
  },
  {
    words: ["organizations", "mainnet-access", "get"],
    operationId: "getMainnetAccess",
    flags: {},
  },
  {
    words: ["organizations", "mainnet-access", "request"],
    operationId: "requestMainnetAccess",
    flags: {
      ...dataFlags,
      "country-code": {
        type: "string",
        description: "Explicit uppercase ISO country code for the organization's jurisdiction",
      },
      "terms-version": {
        type: "string",
        description: "Exact version of the SDP Terms and Conditions you read and accepted",
      },
      "accept-terms": {
        type: "string",
        description:
          "Explicit true acknowledging that terms version; never inferred or supplied automatically",
      },
    },
  },
  {
    words: ["organizations", "mainnet-access", "notify"],
    operationId: "notifyMainnetAccess",
    flags: {},
  },
  {
    words: ["organizations", "provider-availability", "get"],
    operationId: "getOrganizationProviderAccess",
    flags: {},
  },
  {
    words: ["members", "list"],
    operationId: "listMembers",
    flags: {
      page: { type: "string", description: "Page number (1-based)" },
      "page-size": { type: "string", description: "Members and invitations per page (1–100)" },
    },
  },
  { words: ["members", "api-keys", "list"], operationId: "listMemberApiKeys", flags: {} },
  { words: ["members", "get-self"], operationId: "getCurrentMember", flags: {} },
  {
    words: ["members", "update-role"],
    operationId: "updateMemberRole",
    flags: { ...roleFlags, ...idempotencyFlags },
  },
  { words: ["members", "remove"], operationId: "removeMember", flags: { ...idempotencyFlags } },
  { words: ["members", "leave-organization"], operationId: "leaveOrganization", flags: {} },
  {
    words: ["invitations", "create"],
    operationId: "inviteMember",
    flags: {
      ...roleFlags,
      ...idempotencyFlags,
      email: { type: "string", description: "Invitee email address" },
    },
  },
  {
    words: ["invitations", "revoke"],
    operationId: "revokeInvitation",
    flags: { ...idempotencyFlags },
  },
  { words: ["api-keys", "list"], operationId: "listApiKeys", flags: {} },
  { words: ["api-keys", "get"], operationId: "getApiKey", flags: {} },
  { words: ["api-keys", "create"], operationId: "createApiKey", flags: { ...apiKeyFlags } },
  {
    words: ["api-keys", "update"],
    operationId: "updateApiKey",
    flags: {
      ...apiKeyFlags,
      "clear-description": { type: "boolean", description: "Set description to null" },
      "clear-allowed-ips": { type: "boolean", description: "Set the key's allowlist to null" },
      "clear-expiration": { type: "boolean", description: "Set expiresAt to null" },
      "clear-grants": { type: "boolean", description: "Replace grants with an empty array" },
    },
  },
  {
    words: ["api-keys", "rotate"],
    operationId: "rotateApiKey",
    flags: {
      ...dataFlags,
      "grace-period-hours": {
        type: "string",
        description: "Old-key grace period in hours (0–168; server default 24)",
      },
    },
  },
  {
    words: ["api-keys", "revoke"],
    operationId: "revokeApiKey",
    flags: {
      ...dataFlags,
      confirmation: { type: "string", description: "Exact API key name to confirm deactivation" },
      "cancel-recurring-payments": {
        type: "boolean",
        description: "Also cancel recurring payments attributed to this key",
      },
    },
  },
  {
    words: ["wallets", "managed-signing", "initialize-with-wallet"],
    operationId: "initializeWalletSigning",
    flags: {
      ...dataFlags,
      ...providerFlags,
      ...idempotencyFlags,
      "wallet-label": { type: "string", description: "Label for the first wallet" },
      "request-delay-ms": {
        type: "string",
        description: "Provider request delay in milliseconds, where supported",
      },
      network: { type: "string", description: "Provider-specific network identifier" },
      "account-policy": { type: "string", description: "Coinbase CDP account-policy UUID" },
    },
  },
  {
    words: ["wallets", "create"],
    operationId: "createWallet",
    flags: {
      ...dataFlags,
      ...providerFlags,
      ...idempotencyFlags,
      "connection-id": {
        type: "string",
        description: "BYOK custody connection; use instead of --provider",
      },
      label: { type: "string", description: "Wallet display label" },
      purpose: { type: "string", description: "Wallet purpose accepted by the API" },
    },
  },
  {
    words: ["wallets", "delete"],
    operationId: "deleteWallet",
    flags: { ...dataFlags, ...providerFlags, ...walletIdFlags, ...idempotencyFlags },
  },
  {
    words: ["wallets", "managed-signing", "configurations", "list"],
    operationId: "listWalletConfigs",
    flags: {},
  },
  {
    words: ["wallets", "list"],
    operationId: "listWallets",
    flags: {
      ...providerFlags,
      "include-balances": { type: "boolean", description: "Request tracked token balances" },
      view: { type: "string", description: "Optional summary view" },
    },
  },
  {
    words: ["wallets", "balances", "aggregate"],
    operationId: "aggregateWalletBalances",
    flags: { ...providerFlags },
  },
  {
    words: ["wallets", "public-key", "get"],
    operationId: "getWalletPublicKey",
    flags: { ...walletIdFlags },
  },
  {
    words: ["wallets", "signer", "check"],
    operationId: "checkWalletSigner",
    flags: { ...dataFlags, ...walletIdFlags, ...idempotencyFlags },
  },
  {
    words: ["wallets", "get"],
    // biome-ignore lint/security/noSecrets: canonical OpenAPI operation ID, not a credential.
    operationId: "getWalletById",
    flags: {
      "include-balance": {
        type: "string",
        description: "true or false; false performs a metadata-only read",
      },
    },
  },
  {
    words: ["wallets", "update"],
    operationId: "updateWallet",
    flags: {
      ...dataFlags,
      ...idempotencyFlags,
      label: { type: "string", description: "Wallet display label" },
      "clear-label": { type: "boolean", description: "Set the wallet label to null" },
    },
  },
  {
    words: ["counterparties", "field-options", "get"],
    // biome-ignore lint/security/noSecrets: canonical OpenAPI operation ID, not a credential.
    operationId: "getCounterpartyFieldOptions",
    flags: {},
  },
  {
    words: ["counterparties", "list"],
    operationId: "listCounterparties",
    flags: {
      ...paginationFlags,
      "include-archived": { type: "boolean", description: "Include archived counterparties" },
    },
  },
  { words: ["counterparties", "get"], operationId: "getCounterparty", flags: {} },
  {
    words: ["counterparties", "create"],
    operationId: "createCounterparty",
    flags: { ...counterpartyFlags, ...idempotencyFlags },
  },
  {
    words: ["counterparties", "update"],
    operationId: "updateCounterparty",
    flags: {
      ...counterpartyFlags,
      ...idempotencyFlags,
      "clear-external-id": { type: "boolean", description: "Set externalId to null" },
    },
  },
  {
    words: ["counterparties", "archive"],
    operationId: "archiveCounterparty",
    flags: { ...idempotencyFlags },
  },
  {
    words: ["counterparties", "ramp-requirements", "get"],
    operationId: "getCounterpartyRequirements",
    flags: {
      ...rampProviderFlags,
      ...directionFlags,
      "asset-rail": {
        type: "string",
        description: "Canonical crypto asset rail, such as usdc.solana",
      },
      "fiat-currency": { type: "string", description: "Uppercase fiat currency code" },
      "destination-custody-wallet-id": {
        type: "string",
        description: "SDP wallet record ID; required for onramp",
      },
    },
  },
  {
    words: ["counterparties", "ramp-requirements", "check"],
    operationId: "submitCounterpartyRequirements",
    flags: { ...dataFlags, ...rampProviderFlags, ...directionFlags },
  },
  {
    words: ["counterparties", "provider-accounts", "list"],
    // biome-ignore lint/security/noSecrets: canonical OpenAPI operation ID, not a credential.
    operationId: "listCounterpartyProviderAccounts",
    flags: {
      ...rampProviderFlags,
      "fiat-currency": { type: "string", description: "Filter by fiat currency" },
      "destination-country": {
        type: "string",
        description: "Filter by uppercase ISO country code",
      },
    },
  },
  {
    words: ["counterparties", "project-accounts", "list"],
    operationId: "listProjectCounterpartyAccounts",
    flags: {
      ...paginationFlags,
      type: { type: "string", description: "Recipient summary type: crypto_account" },
      search: { type: "string", description: "Search counterparty display names" },
      ids: {
        type: "string",
        description: "Comma-separated account IDs to resolve without pagination",
      },
    },
  },
  {
    words: ["counterparties", "accounts", "list"],
    operationId: "listCounterpartyAccounts",
    flags: {
      ...paginationFlags,
      "include-archived": { type: "boolean", description: "Include archived accounts" },
      "account-kind": { type: "string", description: "Account kind: crypto_wallet" },
    },
  },
  {
    words: ["counterparties", "accounts", "get"],
    operationId: "getCounterpartyAccount",
    flags: {},
  },
  {
    words: ["counterparties", "accounts", "create"],
    operationId: "createCounterpartyAccount",
    flags: {
      ...counterpartyAccountFlags,
      ...idempotencyFlags,
      "account-kind": { type: "string", description: "Account kind: crypto_wallet" },
    },
  },
  {
    words: ["counterparties", "accounts", "update"],
    operationId: "updateCounterpartyAccount",
    flags: {
      ...counterpartyAccountFlags,
      ...idempotencyFlags,
      "clear-label": { type: "boolean", description: "Set the account label to null" },
    },
  },
  {
    words: ["counterparties", "accounts", "archive"],
    operationId: "archiveCounterpartyAccount",
    flags: { ...idempotencyFlags },
  },
  {
    words: ["transfers", "execute"],
    operationId: "createPaymentTransfer",
    flags: {
      ...dataFlags,
      ...paymentSourceFlags,
      ...idempotencyFlags,
      destination: { type: "string", description: "Destination Solana wallet address" },
      amount: {
        type: "string",
        description: "Positive token amount in UI units as an exact decimal string",
      },
      memo: { type: "string", description: "Optional memo (up to 256 characters)" },
      "transfer-id": {
        type: "string",
        description: "Existing awaiting-payment off-ramp transfer to fund",
      },
    },
  },
  {
    words: ["transfers", "list"],
    operationId: "listPaymentTransfers",
    flags: {
      ...paginationFlags,
      ...rampProviderFlags,
      "custody-wallet-id": { type: "string", description: "Filter by exact SDP wallet record ID" },
      asset: { type: "string", description: "Filter by payment token symbol or mint" },
      search: {
        type: "string",
        description: "Search transfer data; blank or at least 3 characters",
      },
      direction: { type: "string", description: "inbound or outbound" },
      status: { type: "string", description: "Comma-separated transfer statuses" },
      category: { type: "string", description: "wallet or ramp" },
      type: { type: "string", description: "Comma-separated transfer types" },
      "counterparty-id": { type: "string", description: "Filter by counterparty ID" },
      "provider-reference": {
        type: "string",
        description: "Exact ramp provider reference; requires --provider",
      },
      from: { type: "string", description: "Start timestamp in ISO 8601 format" },
      to: { type: "string", description: "End timestamp in ISO 8601 format" },
      "include-observed": {
        type: "string",
        description: "true or false; true opts into address history for the selected wallet",
      },
      "sort-by": { type: "string", description: "createdAt, updatedAt, amount, or status" },
      "sort-direction": { type: "string", description: "asc or desc" },
    },
  },
  { words: ["transfers", "get"], operationId: "getPaymentTransfer", flags: {} },
  {
    words: ["transactions", "list"],
    operationId: "listUnifiedTransactions",
    flags: {
      module: {
        type: "string",
        description: "Transaction module; availability and access are checked by the server",
      },
      kind: { type: "string", description: "Module-specific transaction kind; requires --module" },
      status: {
        type: "string",
        description: `History status: ${UNIFIED_TRANSACTION_STATUSES.join(", ")}`,
      },
      "custody-wallet-id": { type: "string", description: "Exact SDP wallet record ID" },
      "counterparty-id": { type: "string", description: "Exact counterparty ID" },
      asset: {
        type: "string",
        description: "Exact token value stored on history rows, usually a Solana mint address",
      },
      search: {
        type: "string",
        description: "Transaction ID, module ID, or signature prefix (3–200 characters)",
      },
      from: {
        type: "string",
        description: "Inclusive creation time lower bound as a UTC ISO timestamp",
      },
      to: {
        type: "string",
        description: "Inclusive creation time upper bound as a UTC ISO timestamp",
      },
      cursor: {
        type: "string",
        description: "Opaque nextCursor from the previous response; keep the same filters",
      },
      limit: {
        type: "string",
        description: "Rows per page (1–100); omitted uses the server default of 50",
      },
    },
  },
  {
    words: ["onramps", "supported-pairs", "list"],
    operationId: "listPaymentOnrampCurrencies",
    flags: {
      ...rampProviderFlags,
      source: { type: "string", description: "Source fiat currency code" },
      dest: { type: "string", description: "Destination crypto rail" },
    },
  },
  {
    words: ["offramps", "supported-pairs", "list"],
    // biome-ignore lint/security/noSecrets: canonical OpenAPI operation ID, not a credential.
    operationId: "listPaymentOfframpCurrencies",
    flags: {
      ...rampProviderFlags,
      source: { type: "string", description: "Source crypto rail" },
      dest: { type: "string", description: "Destination fiat currency code" },
    },
  },
  {
    words: ["onramps", "estimate"],
    operationId: "estimatePaymentOnramp",
    flags: {
      ...rampEstimateFlags,
      "fiat-amount": { type: "string", description: "Fiat amount as an exact decimal string" },
    },
  },
  {
    words: ["offramps", "estimate"],
    operationId: "estimatePaymentOfframp",
    flags: {
      ...rampEstimateFlags,
      "crypto-amount": {
        type: "string",
        description: "Crypto amount in UI units as an exact decimal string",
      },
    },
  },
  {
    words: ["onramps", "start"],
    operationId: "createPaymentOnrampQuote",
    flags: {
      ...rampQuoteFlags,
      "destination-custody-wallet-id": {
        type: "string",
        description: "Exact destination SDP wallet record ID (id from wallets list)",
      },
      "fiat-amount": { type: "string", description: "Fiat amount as an exact decimal string" },
    },
  },
  {
    words: ["offramps", "start"],
    operationId: "createPaymentOfframpQuote",
    flags: {
      ...rampQuoteFlags,
      "source-custody-wallet-id": paymentSourceFlags["source-custody-wallet-id"],
      "crypto-amount": {
        type: "string",
        description: "Crypto amount in UI units as an exact decimal string",
      },
    },
  },
  {
    words: ["ramps", "cancel"],
    operationId: "cancelPaymentRampTransfer",
    flags: rampTransferFlags,
  },
  {
    words: ["ramps", "simulate-settlement"],
    // biome-ignore lint/security/noSecrets: canonical OpenAPI operation ID, not a credential.
    operationId: "simulateSandboxTransfer",
    flags: rampTransferFlags,
  },
  {
    words: ["transfer-batches", "estimate"],
    operationId: "estimatePaymentTransferBatch",
    flags: { ...transferBatchFlags },
  },
  {
    words: ["transfer-batches", "execute"],
    operationId: "createPaymentTransferBatch",
    flags: { ...transferBatchFlags, ...idempotencyFlags },
  },
  {
    words: ["transfer-batches", "list"],
    operationId: "listPaymentTransferBatches",
    flags: {
      ...paginationFlags,
      ...paymentSourceFlags,
      status: { type: "string", description: "Single batch status" },
      "external-id": { type: "string", description: "Filter by batch correlation ID" },
    },
  },
  {
    words: ["transfer-batches", "retry"],
    operationId: "retryPaymentTransferBatch",
    flags: { ...idempotencyFlags },
  },
  { words: ["transfer-batches", "get"], operationId: "getPaymentTransferBatch", flags: {} },
  {
    words: ["payment-requests", "create"],
    operationId: "createPaymentRequest",
    flags: {
      ...dataFlags,
      ...walletIdFlags,
      asset: {
        type: "string",
        description: "Solana token mint address; symbols are not accepted by this endpoint",
      },
      amount: { type: "string", description: "Positive decimal-string amount in token UI units" },
      "expires-at": {
        type: "string",
        description: "Optional UTC ISO timestamp; use JSON null for no expiration",
      },
    },
  },
  {
    words: ["payment-requests", "list"],
    operationId: "listPaymentRequests",
    flags: {
      ...paginationFlags,
      status: { type: "string", description: "Payment request status" },
    },
  },
  {
    words: ["payment-requests", "cancel"],
    operationId: "cancelPaymentRequest",
    flags: { ...idempotencyFlags },
  },
  { words: ["payment-requests", "get"], operationId: "getPaymentRequest", flags: {} },
  {
    words: ["payment-requests", "link-token", "get"],
    operationId: "getPaymentRequestLink",
    flags: {},
  },
  { words: ["payment-links", "get"], operationId: "getPaymentLink", flags: {} },
  { words: ["payment-links", "metadata", "get"], operationId: "getPaymentLinkMetadata", flags: {} },
  {
    words: ["payment-links", "transactions", "build-sponsored-transaction"],
    operationId: "preparePaymentLinkTransaction",
    flags: {
      ...dataFlags,
      account: {
        type: "string",
        description: "Payer Solana account that will sign the returned transaction",
      },
    },
  },
  {
    words: ["recurring-payments", "create"],
    operationId: "createPaymentRecurringPayment",
    flags: { ...recurringTermsFlags, ...idempotencyFlags },
  },
  {
    words: ["recurring-payments", "list"],
    operationId: "listPaymentRecurringPayments",
    flags: {
      ...paginationFlags,
      status: { type: "string", description: "Recurring payment status" },
      "counterparty-id": { type: "string", description: "Filter by counterparty ID" },
    },
  },
  { words: ["recurring-payments", "get"], operationId: "getPaymentRecurringPayment", flags: {} },
  {
    words: ["recurring-payments", "update"],
    operationId: "updatePaymentRecurringPayment",
    flags: {
      ...recurringTermsFlags,
      ...idempotencyFlags,
      "next-collection-due-at": {
        type: "string",
        description: "Next due timestamp for an active schedule",
      },
      "clear-first-collection-at": {
        type: "boolean",
        description: "Clear the pending first-collection override",
      },
      "clear-next-collection-due-at": {
        type: "boolean",
        description: "Reset next due time to the earliest eligible collection",
      },
      "clear-metadata-uri": { type: "boolean", description: "Set metadataUri to null" },
    },
  },
  {
    words: ["recurring-payments", "activate"],
    operationId: "activatePaymentRecurringPayment",
    flags: { ...idempotencyFlags },
  },
  {
    words: ["recurring-payments", "cancel"],
    operationId: "cancelPaymentRecurringPayment",
    flags: { ...idempotencyFlags },
  },
  {
    words: ["recurring-payments", "collect"],
    operationId: "collectPaymentRecurringPayment",
    flags: { ...idempotencyFlags },
  },
  {
    words: ["recurring-payments", "resume"],
    operationId: "resumePaymentRecurringPayment",
    flags: { ...idempotencyFlags },
  },
  {
    words: ["subscription-plans", "create-record"],
    // biome-ignore lint/security/noSecrets: canonical OpenAPI operation ID, not a credential.
    operationId: "createPaymentSubscriptionPlan",
    flags: {
      ...planMutableFlags,
      ...idempotencyFlags,
      "owner-wallet-id": { type: "string", description: "Provider wallet ID owning the plan" },
      asset: { type: "string", description: "Payment token mint or supported symbol" },
      amount: {
        type: "string",
        description: "Charge in token UI units as an exact decimal string",
      },
      "period-hours": { type: "string", description: "Billing period in whole hours (1–8760)" },
      "program-plan-id": {
        type: "string",
        description: "Unsigned 64-bit decimal program plan ID; passed as a string",
      },
    },
  },
  {
    words: ["subscription-plans", "list"],
    // biome-ignore lint/security/noSecrets: canonical OpenAPI operation ID, not a credential.
    operationId: "listPaymentSubscriptionPlans",
    flags: { ...paginationFlags, status: { type: "string", description: "Filter by plan status" } },
  },
  // biome-ignore lint/security/noSecrets: canonical OpenAPI operation ID, not a credential.
  { words: ["subscription-plans", "get"], operationId: "getPaymentSubscriptionPlan", flags: {} },
  {
    words: ["subscription-plans", "update"],
    // biome-ignore lint/security/noSecrets: canonical OpenAPI operation ID, not a credential.
    operationId: "updatePaymentSubscriptionPlan",
    flags: {
      ...planMutableFlags,
      ...idempotencyFlags,
      "clear-plan-pda": { type: "boolean", description: "Set planPda to null" },
      "clear-destination-address": {
        type: "boolean",
        description: "Set destinationAddress to null",
      },
      "clear-puller-wallet-id": { type: "boolean", description: "Set pullerWalletId to null" },
      "clear-metadata-uri": { type: "boolean", description: "Set metadataUri to null" },
    },
  },
  {
    words: ["subscription-plans", "create", "build-unsigned-transaction"],
    operationId: "preparePaymentSubscriptionPlanCreate",
    flags: {
      ...dataFlags,
      destinations: {
        type: "string",
        description: "JSON array of allowed destination addresses (at most 4)",
      },
      pullers: {
        type: "string",
        description: "JSON array of allowed puller addresses (at most 4)",
      },
      "end-ts": {
        type: "string",
        description: "Unsigned 64-bit Unix end timestamp as a decimal string",
      },
      "metadata-uri": { type: "string", description: "HTTP(S) metadata URI to embed in the plan" },
    },
  },
  {
    words: ["subscriptions", "create-record"],
    operationId: "createPaymentSubscription",
    flags: {
      ...dataFlags,
      ...idempotencyFlags,
      "plan-id": { type: "string", description: "SDP subscription plan ID" },
      "counterparty-id": { type: "string", description: "Counterparty being billed" },
      "subscriber-address": { type: "string", description: "Subscriber wallet address" },
    },
  },
  {
    words: ["subscriptions", "list"],
    // biome-ignore lint/security/noSecrets: canonical OpenAPI operation ID, not a credential.
    operationId: "listPaymentSubscriptions",
    flags: {
      ...paginationFlags,
      "plan-id": { type: "string", description: "Filter by SDP plan ID" },
      "counterparty-id": { type: "string", description: "Filter by counterparty ID" },
      status: { type: "string", description: "Filter by subscription status" },
      "due-before": { type: "string", description: "Due-before timestamp in ISO format" },
    },
  },
  // biome-ignore lint/security/noSecrets: canonical OpenAPI operation ID, not a credential.
  { words: ["subscriptions", "get"], operationId: "getPaymentSubscription", flags: {} },
  {
    words: ["subscriptions", "authorize", "build-unsigned-transaction"],
    // biome-ignore lint/security/noSecrets: canonical OpenAPI operation ID, not a credential.
    operationId: "preparePaymentSubscriptionAuthorization",
    flags: {
      ...dataFlags,
      "subscriber-token-account": {
        type: "string",
        description: "Subscriber token account authorizing delegation",
      },
      "expected-plan-created-at": {
        type: "string",
        description: "Consented on-chain plan createdAt as an unsigned 64-bit decimal string",
      },
      "expected-subscription-authority-init-id": {
        type: "string",
        description:
          "Consented authority init ID as a signed 64-bit decimal string; use --flag=-1 for negative values",
      },
    },
  },
  {
    words: ["subscriptions", "cancel", "build-unsigned-transaction"],
    // biome-ignore lint/security/noSecrets: canonical OpenAPI operation ID, not a credential.
    operationId: "preparePaymentSubscriptionCancel",
    flags: { ...dataFlags },
  },
  {
    words: ["subscriptions", "resume", "build-unsigned-transaction"],
    operationId: "preparePaymentSubscriptionResume",
    flags: { ...dataFlags },
  },
  {
    words: ["subscriptions", "collect", "build-unsigned-transaction"],
    // biome-ignore lint/security/noSecrets: canonical OpenAPI operation ID, not a credential.
    operationId: "preparePaymentSubscriptionCollection",
    flags: {
      ...dataFlags,
      "receiver-token-account": {
        type: "string",
        description: "Receiver token account allowed by the on-chain plan",
      },
    },
  },
  {
    words: ["subscriptions", "collection-attempts", "list"],
    // biome-ignore lint/security/noSecrets: canonical OpenAPI operation ID, not a credential.
    operationId: "listPaymentSubscriptionCollectionAttempts",
    flags: {
      ...paginationFlags,
      status: { type: "string", description: "Filter by collection attempt status" },
    },
  },
] as const satisfies readonly Command[];

export function parserOptions(): ParseArgsConfig["options"] {
  const flags: Record<string, Flag> = { ...globalFlags };
  for (const command of commands) Object.assign(flags, command.flags);
  if (flags.type !== undefined) flags.type = { ...flags.type, multiple: true };
  return flags;
}

export function parseJsonObject(text: string, label: string): JsonObject {
  let parsed: JsonObject;
  try {
    parsed = z.record(z.string(), z.json()).parse(JSON.parse(text));
  } catch {
    usageError(`${label} must be a valid JSON object.`);
  }
  return parsed;
}

function organizationSettings(options: Options): JsonObject | undefined {
  const individual =
    options["default-environment"] !== undefined ||
    options["allowed-ip"] !== undefined ||
    options["clear-allowed-ips"] === true;
  if (options.settings !== undefined) {
    if (individual) usageError("Use --settings or individual organization settings flags.");
    return parseJsonObject(options.settings, "--settings");
  }
  if (options["clear-allowed-ips"] && options["allowed-ip"] !== undefined)
    usageError("Use --allowed-ip or --clear-allowed-ips.");
  if (!individual) return undefined;
  const settings: JsonObject = {};
  if (options["default-environment"] !== undefined)
    settings.defaultEnvironment = options["default-environment"];
  if (options["allowed-ip"] !== undefined) settings.allowedIpAddresses = options["allowed-ip"];
  if (options["clear-allowed-ips"]) settings.allowedIpAddresses = [];
  return settings;
}

function projectUpdateFields(options: Options): JsonObject {
  const fields: JsonObject = {};
  if (options["clear-description"] && options.description !== undefined)
    usageError("Use --description or --clear-description.");
  if (options["clear-settings"] && options.settings !== undefined)
    usageError("Use --settings or --clear-settings.");
  if (options["clear-description"]) fields.description = null;
  if (options["clear-settings"]) fields.settings = null;
  if (options.settings !== undefined)
    fields.settings = parseJsonObject(options.settings, "--settings");
  return fields;
}

function apiKeyFields(options: Options): JsonObject {
  const fields: JsonObject = {};
  if (options.grant !== undefined) fields.grants = options.grant;
  if (options["wallet-scope"] !== undefined) fields.walletScope = options["wallet-scope"];
  if (options["wallet-id"] !== undefined) fields.walletIds = options["wallet-id"];
  if (options["allowed-ip"] !== undefined) fields.allowedIps = options["allowed-ip"];
  if (options["expires-at"] !== undefined) fields.expiresAt = options["expires-at"];
  return fields;
}

function apiKeyUpdateFields(options: Options): JsonObject {
  if (options["clear-description"] && options.description !== undefined)
    usageError("Use --description or --clear-description.");
  if (options["clear-allowed-ips"] && options["allowed-ip"] !== undefined)
    usageError("Use --allowed-ip or --clear-allowed-ips.");
  if (options["clear-expiration"] && options["expires-at"] !== undefined)
    usageError("Use --expires-at or --clear-expiration.");
  if (options["clear-grants"] && options.grant !== undefined)
    usageError("Use --grant or --clear-grants.");
  const fields = apiKeyFields(options);
  if (options["clear-description"]) fields.description = null;
  if (options["clear-allowed-ips"]) fields.allowedIps = null;
  if (options["clear-expiration"]) fields.expiresAt = null;
  if (options["clear-grants"]) fields.grants = [];
  return fields;
}

function apiKeyBodyFields(operationId: string, options: Options): JsonObject {
  switch (operationId) {
    case "createProjectApiKey":
    case "createApiKey":
      return apiKeyFields(options);
    case "updateApiKey":
      return apiKeyUpdateFields(options);
    case "rotateApiKey": {
      const fields: JsonObject = {};
      if (options["grace-period-hours"] !== undefined)
        fields.gracePeriodHours = options["grace-period-hours"];
      return fields;
    }
    case "revokeApiKey": {
      const fields: JsonObject = {};
      if (options.confirmation !== undefined) fields.confirmation = options.confirmation;
      if (options["cancel-recurring-payments"] !== undefined)
        fields.cancelRecurringPayments = options["cancel-recurring-payments"];
      return fields;
    }
    default:
      throw new Error(`Missing API key body builder: ${operationId}`);
  }
}

function singleWalletId(options: Options): string | undefined {
  const ids = options["wallet-id"];
  if (ids === undefined) return undefined;
  if (ids.length !== 1) usageError("Supply --wallet-id exactly once for this command.");
  return ids[0];
}

function walletBodyFields(operationId: string, options: Options): JsonObject {
  const fields: JsonObject = {};
  switch (operationId) {
    case "initializeWalletSigning":
      if (options.provider !== undefined) fields.provider = options.provider;
      if (options["wallet-label"] !== undefined) fields.walletLabel = options["wallet-label"];
      if (options["request-delay-ms"] !== undefined)
        fields.requestDelayMs = options["request-delay-ms"];
      if (options.network !== undefined) fields.network = options.network;
      if (options["account-policy"] !== undefined) fields.accountPolicy = options["account-policy"];
      break;
    case "createWallet":
      if (options.provider !== undefined) fields.provider = options.provider;
      if (options["connection-id"] !== undefined) fields.connectionId = options["connection-id"];
      if (options.label !== undefined) fields.label = options.label;
      if (options.purpose !== undefined) fields.purpose = options.purpose;
      break;
    case "deleteWallet":
    case "checkWalletSigner": {
      const walletId = singleWalletId(options);
      if (walletId !== undefined) fields.walletId = walletId;
      if (options.provider !== undefined) fields.provider = options.provider;
      break;
    }
    case "updateWallet":
      if (options["clear-label"] && options.label !== undefined)
        usageError("Use --label or --clear-label.");
      if (options.label !== undefined) fields.label = options.label;
      if (options["clear-label"]) fields.label = null;
      break;
    default:
      throw new Error(`Missing wallet body builder: ${operationId}`);
  }
  return fields;
}

function counterpartyBodyFields(operationId: string, options: Options): JsonObject {
  const fields: JsonObject = {};
  switch (operationId) {
    case "createCounterparty":
    case "updateCounterparty":
      if (options["clear-external-id"] && options["external-id"] !== undefined)
        usageError("Use --external-id or --clear-external-id.");
      if (options["external-id"] !== undefined) fields.externalId = options["external-id"];
      if (options["clear-external-id"]) fields.externalId = null;
      if (options["entity-type"] !== undefined) fields.entityType = options["entity-type"];
      if (options["display-name"] !== undefined) fields.displayName = options["display-name"];
      break;
    case "createCounterpartyAccount":
    case "updateCounterpartyAccount":
      if (options["clear-label"] && options.label !== undefined)
        usageError("Use --label or --clear-label.");
      if (options["account-kind"] !== undefined) fields.accountKind = options["account-kind"];
      if (options.label !== undefined) fields.label = options.label;
      if (options["clear-label"]) fields.label = null;
      if (options.details !== undefined)
        fields.details = parseJsonObject(options.details, "--details");
      if (options["provider-account-data"] !== undefined)
        fields.providerAccountData = parseJsonObject(
          options["provider-account-data"],
          "--provider-account-data"
        );
      break;
    case "submitCounterpartyRequirements":
      if (options.provider !== undefined) fields.provider = options.provider;
      if (options.direction !== undefined) fields.direction = options.direction;
      break;
    default:
      throw new Error(`Missing counterparty body builder: ${operationId}`);
  }
  return fields;
}

function transferBodyFields(operationId: string, options: Options): JsonObject {
  const fields: JsonObject = {};
  if (options["source-custody-wallet-id"] !== undefined)
    fields.sourceCustodyWalletId = options["source-custody-wallet-id"];
  if (options.asset !== undefined) fields.token = options.asset;
  switch (operationId) {
    case "createPaymentTransfer":
      if (options.destination !== undefined) fields.destination = options.destination;
      if (options.amount !== undefined) fields.amount = options.amount;
      if (options.memo !== undefined) fields.memo = options.memo;
      if (options["transfer-id"] !== undefined) fields.transferId = options["transfer-id"];
      break;
    case "createPaymentTransferBatch":
    case "estimatePaymentTransferBatch":
      if (options["external-id"] !== undefined) fields.externalId = options["external-id"];
      if (options.recipients !== undefined) {
        try {
          fields.recipients = z
            .array(z.record(z.string(), z.json()))
            .parse(JSON.parse(options.recipients));
        } catch {
          usageError("--recipients must be a valid JSON array of recipient objects.");
        }
      }
      if (options.options !== undefined)
        fields.options = parseJsonObject(options.options, "--options");
      break;
    default:
      throw new Error(`Missing transfer body builder: ${operationId}`);
  }
  return fields;
}

function recurringBodyFields(options: Options): JsonObject {
  const fields: JsonObject = {};
  if (options["source-custody-wallet-id"] !== undefined)
    fields.sourceCustodyWalletId = options["source-custody-wallet-id"];
  if (options["counterparty-id"] !== undefined) fields.counterpartyId = options["counterparty-id"];
  if (options["counterparty-account-id"] !== undefined)
    fields.counterpartyAccountId = options["counterparty-account-id"];
  if (options.asset !== undefined) fields.token = options.asset;
  if (options.amount !== undefined) fields.amount = options.amount;
  if (options["period-hours"] !== undefined) fields.periodHours = options["period-hours"];
  if (options["first-collection-at"] !== undefined)
    fields.firstCollectionAt = options["first-collection-at"];
  if (options["next-collection-due-at"] !== undefined)
    fields.nextCollectionDueAt = options["next-collection-due-at"];
  if (options["metadata-uri"] !== undefined) fields.metadataUri = options["metadata-uri"];
  if (options["clear-first-collection-at"]) {
    if (options["first-collection-at"] !== undefined)
      usageError("Use --first-collection-at or --clear-first-collection-at.");
    fields.firstCollectionAt = null;
  }
  if (options["clear-next-collection-due-at"]) {
    if (options["next-collection-due-at"] !== undefined)
      usageError("Use --next-collection-due-at or --clear-next-collection-due-at.");
    fields.nextCollectionDueAt = null;
  }
  if (options["clear-metadata-uri"]) {
    if (options["metadata-uri"] !== undefined)
      usageError("Use --metadata-uri or --clear-metadata-uri.");
    fields.metadataUri = null;
  }
  return fields;
}

function planBodyFields(options: Options): JsonObject {
  const fields: JsonObject = {};
  if (options["owner-wallet-id"] !== undefined) fields.ownerWalletId = options["owner-wallet-id"];
  if (options.asset !== undefined) fields.token = options.asset;
  if (options.amount !== undefined) fields.amount = options.amount;
  if (options["period-hours"] !== undefined) fields.periodHours = options["period-hours"];
  if (options["program-plan-id"] !== undefined) fields.programPlanId = options["program-plan-id"];
  if (options["plan-pda"] !== undefined) fields.planPda = options["plan-pda"];
  if (options["destination-address"] !== undefined)
    fields.destinationAddress = options["destination-address"];
  if (options["puller-wallet-id"] !== undefined)
    fields.pullerWalletId = options["puller-wallet-id"];
  if (options["metadata-uri"] !== undefined) fields.metadataUri = options["metadata-uri"];
  if (options.status !== undefined) fields.status = options.status;
  for (const [field, value, clear] of [
    ["planPda", options["plan-pda"], options["clear-plan-pda"]],
    ["destinationAddress", options["destination-address"], options["clear-destination-address"]],
    ["pullerWalletId", options["puller-wallet-id"], options["clear-puller-wallet-id"]],
    ["metadataUri", options["metadata-uri"], options["clear-metadata-uri"]],
  ] as const) {
    if (clear) {
      if (value !== undefined) usageError(`Use a value or its clearing flag for ${field}.`);
      fields[field] = null;
    }
  }
  return fields;
}

function subscriptionBodyFields(operationId: string, options: Options): JsonObject {
  const fields: JsonObject = {};
  switch (operationId) {
    case "preparePaymentSubscriptionPlanCreate":
      for (const field of ["destinations", "pullers"] as const) {
        if (options[field] !== undefined) {
          try {
            fields[field] = z.array(z.string()).parse(JSON.parse(options[field]));
          } catch {
            usageError(`--${field} must be a valid JSON array of addresses.`);
          }
        }
      }
      if (options["end-ts"] !== undefined) fields.endTs = options["end-ts"];
      if (options["metadata-uri"] !== undefined) fields.metadataUri = options["metadata-uri"];
      break;
    case "createPaymentSubscription":
      if (options["plan-id"] !== undefined) fields.planId = options["plan-id"];
      if (options["counterparty-id"] !== undefined)
        fields.counterpartyId = options["counterparty-id"];
      if (options["subscriber-address"] !== undefined)
        fields.subscriberAddress = options["subscriber-address"];
      break;
    // biome-ignore lint/security/noSecrets: canonical OpenAPI operation ID, not a credential.
    case "preparePaymentSubscriptionAuthorization":
      if (options["subscriber-token-account"] !== undefined)
        fields.subscriberTokenAccount = options["subscriber-token-account"];
      if (options["expected-plan-created-at"] !== undefined)
        fields.expectedPlanCreatedAt = options["expected-plan-created-at"];
      if (options["expected-subscription-authority-init-id"] !== undefined)
        fields.expectedSubscriptionAuthorityInitId =
          options["expected-subscription-authority-init-id"];
      break;
    // biome-ignore lint/security/noSecrets: canonical OpenAPI operation ID, not a credential.
    case "preparePaymentSubscriptionCollection":
      if (options["receiver-token-account"] !== undefined)
        fields.receiverTokenAccount = options["receiver-token-account"];
      break;
    // biome-ignore lint/security/noSecrets: canonical OpenAPI operation ID, not a credential.
    case "preparePaymentSubscriptionCancel":
    case "preparePaymentSubscriptionResume":
      break;
    default:
      throw new Error(`Missing subscription body builder: ${operationId}`);
  }
  return fields;
}

function rampBodyFields(operationId: string, options: Options): JsonObject {
  const fields: JsonObject = {};
  // biome-ignore lint/security/noSecrets: canonical OpenAPI operation ID, not a credential.
  if (operationId === "cancelPaymentRampTransfer" || operationId === "simulateSandboxTransfer") {
    if (options["transfer-id"] !== undefined) fields.transferId = options["transfer-id"];
    return fields;
  }
  if (options["asset-rail"] !== undefined) fields.assetRail = options["asset-rail"];
  if (options["fiat-currency"] !== undefined) fields.fiatCurrency = options["fiat-currency"];
  if (options["fiat-amount"] !== undefined) fields.fiatAmount = options["fiat-amount"];
  if (options["crypto-amount"] !== undefined) fields.cryptoAmount = options["crypto-amount"];
  if (options.provider !== undefined) fields.provider = options.provider;
  if (options["counterparty-id"] !== undefined) fields.counterpartyId = options["counterparty-id"];
  if (options["source-custody-wallet-id"] !== undefined)
    fields.sourceCustodyWalletId = options["source-custody-wallet-id"];
  if (options["destination-custody-wallet-id"] !== undefined)
    fields.destinationCustodyWalletId = options["destination-custody-wallet-id"];
  if (options["ramps-memo"] !== undefined)
    fields.rampsMemo = parseJsonObject(options["ramps-memo"], "--ramps-memo");
  return fields;
}

function dvpBodyFields(options: Options): JsonObject {
  const body: JsonObject = {};
  for (const [flag, field] of [
    ["mint-a", "mintA"],
    ["mint-b", "mintB"],
    ["token-program-a", "tokenProgramA"],
    ["token-program-b", "tokenProgramB"],
    ["amount-a", "amountA"],
    ["amount-b", "amountB"],
    ["expiry-timestamp", "expiryTimestamp"],
    ["earliest-settlement-timestamp", "earliestSettlementTimestamp"],
    ["user-a-settlement-destination", "userASettlementDestination"],
    ["user-b-settlement-destination", "userBSettlementDestination"],
    ["ref-string", "refString"],
    ["side", "side"],
    ["custody-wallet-id", "walletId"],
  ] as const) {
    const value = options[flag];
    if (value !== undefined) body[field] = value;
  }
  if (options["party-a"] !== undefined)
    body.partyA = parseJsonObject(options["party-a"], "--party-a");
  if (options["party-b"] !== undefined)
    body.partyB = parseJsonObject(options["party-b"], "--party-b");
  return body;
}

function complianceBodyFields(options: Options): JsonObject {
  const body: JsonObject = {};
  for (const field of ["address", "network", "intent"] as const) {
    const value = options[field];
    if (value !== undefined) body[field] = value;
  }
  return body;
}

function earnBodyFromFlags(options: Options): JsonObject {
  const body: JsonObject = {};
  for (const [flag, field] of earnBodyFields) {
    const value = options[flag];
    if (value !== undefined) body[field] = value;
  }
  if (options.allocations !== undefined)
    body.allocations = parseJsonObject(options.allocations, "--allocations");
  return body;
}

function mainnetAccessBodyFromFlags(options: Options): JsonObject {
  const body: JsonObject = {};
  if (options["country-code"] !== undefined) body.countryCode = options["country-code"];
  if (options["terms-version"] !== undefined) body.termsVersion = options["terms-version"];
  if (options["accept-terms"] !== undefined) body.acceptTerms = options["accept-terms"] === "true";
  return body;
}

export function bodyFromFlags(command: Command, options: Options): JsonObject | null {
  if (!("data" in command.flags)) return null;
  const body: JsonObject = {};
  if (command.words[0] === "dvp") return dvpBodyFields(options);
  if (command.words[0] === "custody") return custodyBodyFromFlags(options, parseJsonObject);
  if (command.words[0] === "places") return placesBodyFromFlags(options);
  if (command.words[0] === "earn") return earnBodyFromFlags(options);
  if (command.words[0] === "helius-rings") return heliusRingsBodyFromFlags(options);
  if (command.words[0] === "private-channels") return privateChannelsBodyFromFlags(options);
  if (command.words[0] === "issuance" || command.words[0] === "asset-profiles")
    return issuanceBodyFromFlags(options, parseJsonObject);
  if (options.name !== undefined) body.name = options.name;
  if (options.description !== undefined) body.description = options.description;
  switch (command.operationId) {
    case "screenComplianceAddress":
      Object.assign(body, complianceBodyFields(options));
      break;
    case "updateProject":
      Object.assign(body, projectUpdateFields(options));
      break;
    case "inviteMember":
      if (options.email !== undefined) body.email = options.email;
      if (options.role !== undefined) body.role = options.role;
      break;
    case "updateMemberRole":
      if (options.role !== undefined) body.role = options.role;
      break;
    case "requestMainnetAccess":
      Object.assign(body, mainnetAccessBodyFromFlags(options));
      break;
    case "createOrganization":
      break;
    case "updateOrganization": {
      const settings = organizationSettings(options);
      if (settings !== undefined) body.settings = settings;
      break;
    }
    case "createCounterparty":
    case "updateCounterparty":
    case "createCounterpartyAccount":
    case "updateCounterpartyAccount":
    case "submitCounterpartyRequirements":
      Object.assign(body, counterpartyBodyFields(command.operationId, options));
      break;
    case "initializeWalletSigning":
    case "createWallet":
    case "deleteWallet":
    case "checkWalletSigner":
    case "updateWallet":
      Object.assign(body, walletBodyFields(command.operationId, options));
      break;
    case "estimatePaymentOnramp":
    case "estimatePaymentOfframp":
    case "createPaymentOnrampQuote":
    case "createPaymentOfframpQuote":
    case "cancelPaymentRampTransfer":
    // biome-ignore lint/security/noSecrets: canonical OpenAPI operation ID, not a credential.
    case "simulateSandboxTransfer":
      Object.assign(body, rampBodyFields(command.operationId, options));
      break;
    case "createPaymentRecurringPayment":
    case "updatePaymentRecurringPayment":
      Object.assign(body, recurringBodyFields(options));
      break;
    // biome-ignore lint/security/noSecrets: canonical OpenAPI operation ID, not a credential.
    case "createPaymentSubscriptionPlan":
    // biome-ignore lint/security/noSecrets: canonical OpenAPI operation ID, not a credential.
    case "updatePaymentSubscriptionPlan":
      Object.assign(body, planBodyFields(options));
      break;
    case "preparePaymentSubscriptionPlanCreate":
    case "createPaymentSubscription":
    // biome-ignore lint/security/noSecrets: canonical OpenAPI operation ID, not a credential.
    case "preparePaymentSubscriptionAuthorization":
    // biome-ignore lint/security/noSecrets: canonical OpenAPI operation ID, not a credential.
    case "preparePaymentSubscriptionCollection":
    // biome-ignore lint/security/noSecrets: canonical OpenAPI operation ID, not a credential.
    case "preparePaymentSubscriptionCancel":
    case "preparePaymentSubscriptionResume":
      Object.assign(body, subscriptionBodyFields(command.operationId, options));
      break;
    case "createPaymentRequest": {
      const walletId = singleWalletId(options);
      if (walletId !== undefined) body.walletId = walletId;
      if (options.asset !== undefined) body.token = options.asset;
      if (options.amount !== undefined) body.amount = options.amount;
      if (options["expires-at"] !== undefined) body.expiresAt = options["expires-at"];
      break;
    }
    case "preparePaymentLinkTransaction":
      if (options.account !== undefined) body.account = options.account;
      break;
    case "createPaymentTransfer":
    case "createPaymentTransferBatch":
    case "estimatePaymentTransferBatch":
      Object.assign(body, transferBodyFields(command.operationId, options));
      break;
    case "createProjectApiKey":
    case "createApiKey":
    case "updateApiKey":
    case "rotateApiKey":
    case "revokeApiKey":
      Object.assign(body, apiKeyBodyFields(command.operationId, options));
      break;
    default:
      throw new Error(`Missing body builder: ${command.operationId}`);
  }
  return body;
}

export function queryFromFlags(command: Command, options: Options): Record<string, QueryValue> {
  const parameters = operationById(command.operationId).parameters.filter(
    (parameter) => parameter.location === "query"
  );
  const values: Record<string, QueryValue | undefined> = {
    includeArchived: options["include-archived"],
    minimumSlot: options["minimum-slot"],
    page: options.page,
    pageSize: options["page-size"],
    provider: options.provider,
    source: options.source,
    dest: options.dest,
    includeBalances: options["include-balances"],
    includeBalance: options["include-balance"],
    view: options.view,
    accountKind: options["account-kind"],
    direction: options.direction,
    assetRail: options["asset-rail"],
    fiatCurrency: options["fiat-currency"],
    destinationCustodyWalletId: options["destination-custody-wallet-id"],
    destinationCountry: options["destination-country"],
    type: options.type,
    search: options.search,
    ids: options.ids,
    sourceCustodyWalletId: options["source-custody-wallet-id"],
    custodyWalletId: options["custody-wallet-id"],
    token: options.asset,
    status: options.status,
    externalId: options["external-id"],
    category: options.category,
    counterpartyId: options["counterparty-id"],
    providerReference: options["provider-reference"],
    from: options.from,
    to: options.to,
    includeObserved: options["include-observed"],
    sortBy: options["sort-by"],
    sortDirection: options["sort-direction"],
    planId: options["plan-id"],
    dueBefore: options["due-before"],
    q: options.search,
    settlementAvailability: options["settlement-availability"],
    module: options.module,
    kind: options.kind,
    cursor: options.cursor,
    limit: options.limit,
    createdAtFrom: options.from,
    createdAtTo: options.to,
  };
  for (const [flag, field] of earnQueryFields) values[field] = options[flag];
  for (const [flag, field] of issuanceQueryFields) values[field] = options[flag];
  for (const [flag, field] of placesQueryFields) values[field] = options[flag];
  if (command.words[0] === "private-channels")
    for (const [flag, field] of privateChannelsQueryFields) values[field] = options[flag];
  if (parameters.some((parameter) => parameter.name === "walletId"))
    values.walletId = singleWalletId(options);
  if (command.words[0] === "custody")
    for (const [flag, field] of custodyQueryFields) values[field] = options[flag];
  const query: Record<string, QueryValue> = {};
  for (const parameter of parameters) {
    const value = values[parameter.name];
    if (value === undefined) continue;
    if (Array.isArray(value) && parameter.schema.type !== "array") {
      if (value.length !== 1) usageError(`Supply one value for ${parameter.name} on this command.`);
      query[parameter.name] = value[0];
    } else query[parameter.name] = value;
  }
  return query;
}
