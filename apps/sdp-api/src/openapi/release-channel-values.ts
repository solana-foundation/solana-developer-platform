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
import { z } from "zod";

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

export type Owner = { module: SdpModule } | { rampProvider: RampProviderId };

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
  value: string,
  modules: ReadonlySet<SdpModule>,
  releaseChannel: SdpReleaseChannel
): boolean {
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

/** The module or ramp provider that owns a value, for consumers that filter by channel. */
export function valueGates(): Record<string, Owner> {
  return Object.fromEntries(VALUE_OWNERS);
}

const EMPTY = Symbol("empty schema");
type Json = string | number | boolean | null | Json[] | JsonObject;
type JsonObject = { [key: string]: Json };
type Published = (value: Json) => boolean;

/** The generated document as checked JSON, so the walkers below never see `unknown`. */
const jsonSchema: z.ZodType<Json> = z.json();

function isKept(value: Json | typeof EMPTY): value is Json {
  return value !== EMPTY;
}

/**
 * The pruned document handed back as an OpenAPIObject: pruning only removes
 * members from what the generator produced, so its top level is all that can
 * have gone wrong.
 */
const openApiDocumentSchema = z.custom<OpenAPIObject>((value) => {
  const json = jsonSchema.safeParse(value);
  return (
    json.success &&
    isJsonObject(json.data) &&
    typeof json.data.openapi === "string" &&
    isJsonObject(json.data.info) &&
    isJsonObject(json.data.paths)
  );
}, "The public OpenAPI document pruned to nothing");

function isJsonObject(value: Json | undefined): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

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
  if (isJsonObject(value)) {
    const entries = Object.entries(value);
    if (entries.some(([, field]) => typeof field === "string" && !published(field))) {
      return undefined;
    }
    const result: JsonObject = {};
    for (const [key, field] of entries) {
      const kept = pruneExample(field, published);
      if (kept !== undefined) result[key] = kept;
    }
    return result;
  }
  return value;
}

/**
 * Where a node sits: request schemas (bodies, parameters) list exactly what the
 * channel accepts; response schemas must also accept what a deployment already
 * stores, such as an API key saved with a scope the channel now leaves out.
 */
type Context = { published: Published; inResponse: boolean };

/**
 * An enum without the unpublished values. In a request it narrows; in a
 * response a narrowed list would reject stored records, so it opens up to its
 * base type instead (a forward-compatible enum), still naming no unpublished
 * value. An enum with nothing published is EMPTY either way: the branch,
 * property or parameter it decides goes.
 */
function pruneEnum(values: Json[], context: Context): Json[] | undefined | typeof EMPTY {
  const kept = values.filter(context.published);
  if (kept.length === 0) return EMPTY;
  if (context.inResponse && kept.length < values.length) return undefined;
  return kept;
}

function pruneExamples(value: Json, context: Context): JsonObject | undefined {
  if (!isJsonObject(value)) return undefined;
  const kept: JsonObject = {};
  for (const [name, example] of Object.entries(value)) {
    if (!isJsonObject(example)) continue;
    const prunedValue = pruneExample(example.value, context.published);
    if (prunedValue !== undefined) kept[name] = { ...example, value: prunedValue };
  }
  return Object.keys(kept).length > 0 ? kept : undefined;
}

function pruneProperties(
  value: JsonObject,
  required: Json | undefined,
  context: Context
): JsonObject | typeof EMPTY {
  const properties: JsonObject = {};
  const dropped = new Set<string>();
  for (const [name, schema] of Object.entries(value)) {
    const kept = pruneNode(schema, context);
    if (kept === EMPTY) dropped.add(name);
    else properties[name] = kept;
  }
  // A required property with no publishable value leaves no publishable object.
  const requiredNames = Array.isArray(required) ? required : [];
  if (requiredNames.some((name) => typeof name === "string" && dropped.has(name))) return EMPTY;
  return properties;
}

function pruneParameters(parameters: Json[], context: Context): Json[] {
  // An operation's parameter list: a query parameter left with no value goes.
  return parameters
    .filter(
      (parameter) =>
        !isJsonObject(parameter) ||
        parameter.schema === undefined ||
        pruneNode(parameter.schema, context) !== EMPTY
    )
    .map((parameter) => pruneNode(parameter, context))
    .filter(isKept);
}

/**
 * Prunes one node. Returns EMPTY for a schema that can no longer hold any value
 * (every enum value unpublished, or no `oneOf` branch left), so its parent drops
 * the property, branch or parameter.
 */
function pruneNode(node: Json, context: Context): Json | typeof EMPTY {
  if (Array.isArray(node)) {
    return node.map((entry) => pruneNode(entry, context)).filter(isKept);
  }
  if (!isJsonObject(node)) return node;

  const result: JsonObject = {};
  for (const [key, value] of Object.entries(node)) {
    if (key === "enum" && Array.isArray(value)) {
      const kept = pruneEnum(value, context);
      if (kept === EMPTY) return EMPTY;
      if (kept !== undefined) result.enum = kept;
    } else if (key === "example" || key === "default") {
      const kept = pruneExample(value, context.published);
      if (kept !== undefined) result[key] = kept;
    } else if (key === "examples") {
      const kept = pruneExamples(value, context);
      if (kept !== undefined) result.examples = kept;
    } else if ((key === "oneOf" || key === "anyOf") && Array.isArray(value)) {
      const branches = value.map((branch) => pruneNode(branch, context)).filter(isKept);
      if (branches.length === 0) return EMPTY;
      result[key] = branches;
    } else if (key === "allOf" && Array.isArray(value)) {
      const branches = value.map((branch) => pruneNode(branch, context));
      if (branches.includes(EMPTY)) return EMPTY;
      result.allOf = branches.filter(isKept);
    } else if (key === "items") {
      const kept = pruneNode(value, context);
      if (kept === EMPTY) return EMPTY;
      result.items = kept;
    } else if (key === "properties" && isJsonObject(value)) {
      const kept = pruneProperties(value, node.required, context);
      if (kept === EMPTY) return EMPTY;
      result.properties = kept;
    } else if (key === "parameters" && Array.isArray(value)) {
      result.parameters = pruneParameters(value, context);
    } else {
      const kept = pruneNode(value, {
        ...context,
        inResponse: context.inResponse || key === "responses",
      });
      if (kept === EMPTY) {
        throw new Error(`OpenAPI ${key} has no value its release channel publishes`);
      }
      result[key] = kept;
    }
  }
  return result;
}

/**
 * Removes every value the document's release channel does not publish: enum
 * members (request enums narrow, response enums open up), examples and defaults
 * naming one, and the properties, `oneOf` branches and query parameters left
 * with no value.
 */
export function pruneUnpublishedValues(
  document: OpenAPIObject,
  releaseChannel: SdpReleaseChannel,
  publishEarn: boolean
): OpenAPIObject {
  const modules = publishedModules(releaseChannel, publishEarn);
  // The generator's output is plain JSON; checking it as such types every node.
  const json = jsonSchema.parse(JSON.parse(JSON.stringify(document)));
  const pruned = pruneNode(json, {
    // Only strings name modules; numbers, booleans and null are always kept.
    published: (value) =>
      typeof value !== "string" || isValuePublished(value, modules, releaseChannel),
    inResponse: false,
  });
  if (pruned === EMPTY) throw new Error("The public OpenAPI document pruned to nothing");
  return openApiDocumentSchema.parse(pruned);
}
