import {
  type AllowedOperation,
  type CustodyWalletPurpose,
  isRampProviderInReleaseChannel,
  type Permission,
  RAMP_PROVIDERS,
  RAMP_TRANSFER_TYPES,
  type RampProviderId,
  RETIRED_RAMP_PROVIDERS,
  SDP_RAMP_PROVIDER_STAGES,
  SDP_RELEASE_CHANNELS,
  type SdpModule,
  type SdpReleaseChannel,
  TOKEN_TRANSACTION_TYPES,
  UNIFIED_TRANSACTION_SDP_MODULES,
} from "@sdp/types";
import type { OpenAPIObject } from "openapi3-ts/oas30";

/**
 * Value-level visibility for the public OpenAPI document. Removing a module's
 * routes is not enough: shared schemas name its values too (an API key's
 * `earn:write` scope, a `mint_authority` wallet purpose, a `moonpay` transfer
 * provider). Every enum value a module owns is classified here, from the
 * catalogs in `@sdp/types`, and `pruneUnpublishedValues` drops the ones the
 * document's channel does not publish. The `Record` types make a new permission,
 * operation or wallet purpose fail to compile until it is classified.
 */

/** `core` values run in every release channel. */
type ValueOwner = SdpModule | "core";

const PERMISSION_OWNERS = {
  "tokens:read": "issuance",
  "tokens:write": "issuance",
  "tokens:admin": "issuance",
  "payments:read": "payments",
  "payments:write": "payments",
  "earn:read": "earn",
  "earn:write": "earn",
  "counterparties:read": "payments",
  "counterparties:write": "payments",
  "wallets:read": "custody",
  "wallets:write": "custody",
  "compliance:read": "compliance",
  "compliance:write": "compliance",
  "webhooks:read": "core",
  "webhooks:write": "core",
  "transactions:read": "core",
  "transactions:write": "core",
  "audit:read": "core",
  "org:read": "core",
  "org:write": "core",
  "org:admin": "core",
  "api-keys:read": "core",
  "api-keys:write": "core",
  "projects:read": "core",
  "projects:write": "core",
  "projects:admin": "core",
  "project-members:read": "core",
  "project-members:write": "core",
  "sessions:read": "core",
  "sessions:write": "core",
  "custody:read": "custody",
  "custody:write": "custody",
  "custody:admin": "custody",
  "*": "core",
} as const satisfies Record<Permission, ValueOwner>;

/** `program` covers DvP and Earn, so Markets owns it (in a channel with either). */
const ALLOWED_OPERATION_OWNERS = {
  privacy: "helius_rings",
  payment: "payments",
  ramp: "ramps",
  issuance: "issuance",
  program: "markets",
  payment_transfer_execute: "payments",
  payment_transfer_batch_execute: "payments",
  recurring_payment_create: "recurring_payments",
  recurring_payment_update: "recurring_payments",
  recurring_payment_collection: "recurring_payments",
  ramp_onramp_quote: "ramps",
  ramp_offramp_quote: "ramps",
  issuance_allowlist_add_execute: "issuance",
  issuance_allowlist_remove_execute: "issuance",
  issuance_burn_execute: "issuance",
  issuance_deploy_execute: "issuance",
  issuance_force_burn_execute: "issuance",
  issuance_freeze_execute: "issuance",
  issuance_metadata_update_execute: "issuance",
  issuance_mint_execute: "issuance",
  issuance_pause_execute: "issuance",
  issuance_seize_execute: "issuance",
  issuance_unfreeze_execute: "issuance",
  issuance_unpause_execute: "issuance",
  issuance_update_authority_execute: "issuance",
  dvp_fund: "dvp",
  dvp_settle: "dvp",
  earn_vault_deposit: "earn",
  earn_vault_withdrawal: "earn",
  earn_program_withdrawal: "earn",
  rings_shield: "helius_rings",
  rings_transfer_registered: "helius_rings",
  rings_transfer_anonymous: "helius_rings",
  rings_withdraw: "helius_rings",
  rings_merge: "helius_rings",
  rings_timelock_create: "helius_rings",
  rings_timelock_settle: "helius_rings",
  rings_zone_create: "helius_rings",
  rings_ring_exit: "helius_rings",
  rings_ring_entry: "helius_rings",
} as const satisfies Record<AllowedOperation, ValueOwner>;

const WALLET_PURPOSE_OWNERS = {
  root: "core",
  mint_authority: "issuance",
  freeze_authority: "issuance",
  fee_payer: "core",
  transfer: "core",
  dvp_settlement_authority: "dvp",
} as const satisfies Record<CustodyWalletPurpose, ValueOwner>;

type Owner = { module: SdpModule } | { rampProvider: RampProviderId };

function buildOwners(): ReadonlyMap<string, Owner> {
  const owners = new Map<string, Owner>();
  const own = (value: string, owner: Owner) => {
    const existing = owners.get(value);
    if (existing && JSON.stringify(existing) !== JSON.stringify(owner)) {
      throw new Error(`OpenAPI value "${value}" is claimed by two owners`);
    }
    owners.set(value, owner);
  };
  for (const table of [PERMISSION_OWNERS, ALLOWED_OPERATION_OWNERS, WALLET_PURPOSE_OWNERS]) {
    for (const [value, owner] of Object.entries(table)) {
      if (owner !== "core") own(value, { module: owner });
    }
  }
  for (const [value, module] of Object.entries(UNIFIED_TRANSACTION_SDP_MODULES)) {
    own(value, { module });
  }
  for (const value of TOKEN_TRANSACTION_TYPES) own(value, { module: "issuance" });
  for (const value of [...RAMP_TRANSFER_TYPES, "offramp_channel", "ramps"]) {
    own(value, { module: "ramps" });
  }
  for (const provider of RAMP_PROVIDERS) own(provider, { rampProvider: provider });
  // Retired providers have no stage; their stored rows read under Ramps.
  for (const provider of RETIRED_RAMP_PROVIDERS) own(provider, { module: "ramps" });
  return owners;
}

const VALUE_OWNERS = buildOwners();

/**
 * The modules a public document publishes: those in the release channel, less
 * Earn while its publication hold is on. Markets follows its sub-modules.
 */
export function publishedModules(
  releaseChannel: SdpReleaseChannel,
  publishEarn: boolean
): ReadonlySet<SdpModule> {
  const modules = new Set<SdpModule>(SDP_RELEASE_CHANNELS[releaseChannel]);
  if (!publishEarn) modules.delete("earn");
  if (modules.has("earn") || modules.has("dvp")) modules.add("markets");
  else modules.delete("markets");
  return modules;
}

/** Whether a public document for `modules` may name `value`. Unclassified values are core. */
export function isValuePublished(
  value: unknown,
  modules: ReadonlySet<SdpModule>,
  releaseChannel: SdpReleaseChannel
): boolean {
  if (typeof value !== "string") return true;
  const owner = VALUE_OWNERS.get(value);
  if (!owner) return true;
  if ("module" in owner) return modules.has(owner.module);
  return (
    modules.has("ramps") &&
    isRampProviderInReleaseChannel(releaseChannel, owner.rampProvider, SDP_RAMP_PROVIDER_STAGES)
  );
}

/** Every classified value, for tests that scan a document for leaks. */
export function classifiedValues(): readonly string[] {
  return [...VALUE_OWNERS.keys()];
}

const EMPTY = Symbol("empty schema");
type Json = unknown;
type Published = (value: unknown) => boolean;

/**
 * An example without the unpublished values: a string the channel does not
 * publish, or an object naming one (a provider-availability entry), is dropped.
 */
function pruneExample(value: Json, published: Published): Json | undefined {
  if (typeof value === "string") return published(value) ? value : undefined;
  if (Array.isArray(value)) {
    const kept = value
      .map((entry) => pruneExample(entry, published))
      .filter((entry) => entry !== undefined);
    return kept.length === 0 && value.length > 0 ? undefined : kept;
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value);
    if (entries.some(([, field]) => typeof field === "string" && !published(field))) {
      return undefined;
    }
    const result: Record<string, Json> = {};
    for (const [key, field] of entries) {
      const kept = pruneExample(field, published);
      if (kept !== undefined) result[key] = kept;
    }
    return result;
  }
  return value;
}

/**
 * Prunes one node. Returns EMPTY for a schema that can no longer hold any value
 * (every enum value unpublished, or no `oneOf` branch left), so its parent drops
 * the property, branch or parameter.
 */
function pruneNode(node: Json, published: Published): Json | typeof EMPTY {
  if (Array.isArray(node)) {
    return node.map((entry) => pruneNode(entry, published)).filter((entry) => entry !== EMPTY);
  }
  if (!node || typeof node !== "object") return node;

  const source = node as Record<string, Json>;
  const result: Record<string, Json> = {};
  for (const [key, value] of Object.entries(source)) {
    switch (key) {
      case "enum": {
        const kept = (value as Json[]).filter(published);
        if (kept.length === 0) return EMPTY;
        result.enum = kept;
        break;
      }
      case "example":
      case "default": {
        const kept = pruneExample(value, published);
        if (kept !== undefined) result[key] = kept;
        break;
      }
      case "examples": {
        const kept: Record<string, Json> = {};
        for (const [name, example] of Object.entries(value as Record<string, Json>)) {
          const exampleValue = (example as { value?: Json }).value;
          const prunedValue = pruneExample(exampleValue, published);
          if (prunedValue !== undefined)
            kept[name] = { ...(example as object), value: prunedValue };
        }
        if (Object.keys(kept).length > 0) result.examples = kept;
        break;
      }
      case "oneOf":
      case "anyOf": {
        const kept = pruneNode(value, published) as Json[];
        if (kept.length === 0) return EMPTY;
        result[key] = kept;
        break;
      }
      case "allOf": {
        const branches = (value as Json[]).map((branch) => pruneNode(branch, published));
        if (branches.includes(EMPTY)) return EMPTY;
        result.allOf = branches;
        break;
      }
      case "items": {
        const kept = pruneNode(value, published);
        if (kept === EMPTY) return EMPTY;
        result.items = kept;
        break;
      }
      case "properties": {
        const properties: Record<string, Json> = {};
        const dropped = new Set<string>();
        for (const [name, schema] of Object.entries(value as Record<string, Json>)) {
          const kept = pruneNode(schema, published);
          if (kept === EMPTY) dropped.add(name);
          else properties[name] = kept;
        }
        result.properties = properties;
        if (dropped.size > 0 && Array.isArray(source.required)) {
          // A required property with no publishable value leaves no publishable object.
          if (source.required.some((name) => dropped.has(name as string))) return EMPTY;
        }
        break;
      }
      default: {
        if (key === "parameters" && Array.isArray(value)) {
          // An operation's parameter list: a query parameter left with no value goes.
          result.parameters = value
            .filter((parameter) => {
              const schema = (parameter as { schema?: Json }).schema;
              return schema === undefined || pruneNode(schema, published) !== EMPTY;
            })
            .map((parameter) => pruneNode(parameter, published));
          break;
        }
        const kept = pruneNode(value, published);
        if (kept === EMPTY) {
          throw new Error(`OpenAPI ${key} has no value its release channel publishes`);
        }
        result[key] = kept;
      }
    }
  }
  return result;
}

/**
 * Removes every value the document's release channel does not publish: enum
 * members, examples and defaults naming one, and the properties, `oneOf`
 * branches and query parameters left with no value.
 */
export function pruneUnpublishedValues(
  document: OpenAPIObject,
  releaseChannel: SdpReleaseChannel,
  publishEarn: boolean
): OpenAPIObject {
  const modules = publishedModules(releaseChannel, publishEarn);
  const published: Published = (value) => isValuePublished(value, modules, releaseChannel);
  const pruned = pruneNode(document, published);
  if (pruned === EMPTY) throw new Error("The public OpenAPI document pruned to nothing");
  return pruned as OpenAPIObject;
}
