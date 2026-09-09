import { formatDecimalAmount } from "@sdp/solana/amount";
import type {
  CryptoRailId,
  RampPayoutAccountSpec,
  RampPayoutFieldSpec,
} from "@sdp/types/payment-rails";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { providerUnavailable } from "../../../errors";
import {
  basicAuthHeader,
  isActiveIso4217CurrencyCode,
  isSolanaCryptoAsset,
  RAMP_RAIL_DUMPS,
  SOLANA_ASSET_TO_RAIL,
} from "../../shared";
import {
  type ProviderRailSupportDistillation,
  type RampDiscoveryContext,
  rampPayoutAccountSchema,
} from "../../types";
import { readLightsparkConfig } from "./client";

/** Lightspark only supports usdc.solana for now, so corridors are discovered from USDC alone. */
const LIGHTSPARK_DISCOVERY_CRYPTO = "USDC";

const LIGHTSPARK_OPENAPI_URL =
  "https://raw.githubusercontent.com/lightsparkdev/grid-api/refs/heads/main/openapi.yaml";

/**
 * UI input masks by currency and field key. Masks are presentation-only and
 * have no machine source in the OpenAPI spec; the masked separators must be
 * stripped before validating against the spec pattern.
 */
const LIGHTSPARK_FIELD_MASKS: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  GBP: { sortCode: "##-##-##" },
};

const gridRateCurrencySchema = z.object({
  code: z.string(),
  decimals: z.number().int().nonnegative(),
});

const gridExchangeRatesDumpSchema = z.object({
  data: z.array(
    z.object({
      sourceCurrency: gridRateCurrencySchema,
      destinationCurrency: gridRateCurrencySchema,
      minSendingAmount: z.number(),
      maxSendingAmount: z.number(),
    })
  ),
});

type GridExchangeRateRow = z.infer<typeof gridExchangeRatesDumpSchema>["data"][number];

interface MinorUnitLimit {
  min: number;
  max: number;
  decimals: number;
}

/**
 * Merges one corridor's sending bounds into the per-currency limit table.
 * Currencies reachable over several rails keep the widest bounds.
 *
 * @param limits - Accumulator keyed by currency code.
 * @param code - Normalized currency code the corridor pays out in.
 * @param row - Exchange-rate row carrying the corridor's sending bounds.
 */
function mergeSendingLimit(
  limits: Map<string, MinorUnitLimit>,
  code: string,
  row: GridExchangeRateRow
): void {
  if (!Number.isInteger(row.minSendingAmount) || !Number.isInteger(row.maxSendingAmount)) {
    throw providerUnavailable(`Lightspark ${code} sending limits must be integer minor units.`);
  }
  const existing = limits.get(code);
  if (existing === undefined) {
    limits.set(code, {
      min: row.minSendingAmount,
      max: row.maxSendingAmount,
      decimals: row.sourceCurrency.decimals,
    });
    return;
  }
  if (existing.decimals !== row.sourceCurrency.decimals) {
    throw providerUnavailable(`Lightspark ${code} corridors disagree on source currency decimals.`);
  }
  existing.min = Math.min(existing.min, row.minSendingAmount);
  existing.max = Math.max(existing.max, row.maxSendingAmount);
}

/**
 * Distills Lightspark exchange-rate corridors into the rail-support snapshot.
 * Off-ramp rows come from `exchange-rates?sourceCurrency=USDC` (crypto out to
 * fiat), on-ramp rows from `exchange-rates?destinationCurrency=USDC` (fiat in
 * to crypto). Limits are sending-amount bounds denominated in each corridor's
 * source currency: USDC for off-ramps, the fiat currency for on-ramps.
 * Crypto-to-crypto corridors are skipped; inactive ISO 4217 codes are dropped
 * and reported.
 *
 * @param offrampRatesRaw - Raw `sourceCurrency=USDC` exchange-rates dump.
 * @param onrampRatesRaw - Raw `destinationCurrency=USDC` exchange-rates dump.
 * @returns Snapshot plus the currency codes dropped from it.
 */
export function distillLightsparkRailSupport(
  offrampRatesRaw: unknown,
  onrampRatesRaw: unknown,
  openapiRaw: unknown
): ProviderRailSupportDistillation {
  const droppedCurrencyCodes = new Set<string>();
  const offramp = distillDirection(offrampRatesRaw, "sourceCurrency", droppedCurrencyCodes);
  const onramp = distillDirection(onrampRatesRaw, "destinationCurrency", droppedCurrencyCodes);
  const accounts = distillLightsparkPayoutAccounts(
    openapiRaw,
    Object.keys(offramp.currencies).sort()
  );
  const swiftAccount = distillLightsparkPayoutAccounts(openapiRaw, ["SWIFT"]).SWIFT;
  return {
    snapshot: { onramp, offramp: { ...offramp, accounts, swiftAccount } },
    droppedCurrencyCodes: [...droppedCurrencyCodes].sort(),
    droppedCountryCodes: [],
  };
}

/**
 * Distills one direction's corridors: the crypto side must always be a known
 * Solana asset, the other side is the fiat currency table. Crypto-to-crypto
 * corridors are skipped; non-ISO fiat codes are collected as dropped.
 *
 * @param raw - Raw exchange-rates dump for the direction.
 * @param cryptoSide - Which side of each corridor carries the crypto asset.
 * @param dropped - Accumulator for currency codes excluded from the snapshot.
 * @returns The direction's snapshot slice.
 */
function distillDirection(
  raw: unknown,
  cryptoSide: "sourceCurrency" | "destinationCurrency",
  dropped: Set<string>
) {
  const fiatSide = cryptoSide === "sourceCurrency" ? "destinationCurrency" : "sourceCurrency";
  const limits = new Map<string, MinorUnitLimit>();
  const cryptos = new Set<CryptoRailId>();
  for (const row of gridExchangeRatesDumpSchema.parse(raw).data) {
    const crypto = row[cryptoSide].code.trim().toUpperCase();
    if (!isSolanaCryptoAsset(crypto)) {
      throw providerUnavailable(
        `Lightspark rate ${cryptoSide} must be a crypto asset; got ${crypto}.`
      );
    }
    cryptos.add(SOLANA_ASSET_TO_RAIL[crypto]);
    const fiat = row[fiatSide].code.trim().toUpperCase();
    if (isSolanaCryptoAsset(fiat)) {
      continue;
    }
    if (!isActiveIso4217CurrencyCode(fiat)) {
      dropped.add(fiat);
      continue;
    }
    mergeSendingLimit(limits, fiat, row);
  }
  const currencies = Object.fromEntries(
    [...limits.entries()].map(([code, limit]) => [
      code,
      {
        min: formatDecimalAmount(BigInt(limit.min), limit.decimals),
        max: formatDecimalAmount(BigInt(limit.max), limit.decimals),
      },
    ])
  );
  return { currencies, cryptos: [...cryptos].sort() };
}

const openapiPropertySchema = z.looseObject({
  pattern: z.string().optional(),
  minLength: z.number().int().optional(),
  maxLength: z.number().int().optional(),
  enum: z.array(z.string()).optional(),
});

const openapiAccountBaseSchema = z.looseObject({
  required: z.array(z.string()).optional(),
  description: z.string().optional(),
  properties: z.record(z.string(), openapiPropertySchema),
});

const openapiAccountInfoSchema = z.looseObject({
  allOf: z.array(
    z.looseObject({
      properties: z
        .looseObject({
          paymentRails: z
            .looseObject({ items: z.looseObject({ enum: z.array(z.string()) }) })
            .optional(),
        })
        .optional(),
    })
  ),
});

const openapiDocSchema = z.looseObject({
  components: z.looseObject({ schemas: z.record(z.string(), z.unknown()) }),
});

type OpenapiProperty = z.infer<typeof openapiPropertySchema>;

/**
 * Maps one OpenAPI property onto the snapshot field shape, merging in any
 * hand-maintained UI mask for the currency.
 *
 * @param currency - Payout currency the field belongs to.
 * @param key - Field key within the account schema.
 * @param property - OpenAPI property definition.
 * @param required - Whether the selected rail requires the field.
 * @returns Snapshot field spec.
 */
function toPayoutField(
  currency: string,
  key: string,
  property: OpenapiProperty,
  required: boolean
): RampPayoutFieldSpec {
  const field: RampPayoutFieldSpec = { required };
  if (property.pattern !== undefined) {
    field.pattern = property.pattern;
  }
  if (property.minLength !== undefined) {
    field.minLength = property.minLength;
  }
  if (property.maxLength !== undefined) {
    field.maxLength = property.maxLength;
  }
  if (property.enum !== undefined) {
    field.values = property.enum;
  }
  const mask = LIGHTSPARK_FIELD_MASKS[currency]?.[key];
  if (mask !== undefined) {
    field.mask = mask;
  }
  return field;
}

/**
 * Parses the "Required fields depend on the selected paymentRails" description
 * format into a rail -> required-field-keys map.
 *
 * @param description - OpenAPI account base description.
 * @returns Per-rail required field keys, or null when fields do not vary by rail.
 */
function parsePerRailRequirements(description: string): Record<string, string[]> | null {
  if (!/Required fields depend/.test(description)) {
    return null;
  }
  const perRail: Record<string, string[]> = {};
  for (const line of description.split("\n")) {
    const match = line.match(/^- ([A-Z_]+): (.+)$/);
    if (match === null) {
      continue;
    }
    perRail[match[1]] = match[2]
      .split(",")
      .map((part) => part.trim().split(" ")[0].replace(/\.$/, ""));
  }
  if (Object.keys(perRail).length === 0) {
    throw providerUnavailable(
      "Lightspark OpenAPI per-rail description matched the marker but no rail lines parsed."
    );
  }
  return perRail;
}

/**
 * Distills one currency's payout account from the OpenAPI schemas: account
 * type, rails, and the exact field set (with validation) each rail needs.
 *
 * @param schemas - OpenAPI components.schemas table.
 * @param currency - Off-ramp fiat currency to distill.
 * @returns Payout account spec for the currency.
 */
function distillPayoutAccount(
  schemas: Record<string, unknown>,
  currency: string
): RampPayoutAccountSpec {
  const pascal = currency[0] + currency.slice(1).toLowerCase();
  const baseRaw = schemas[`${pascal}AccountInfoBase`];
  const infoRaw = schemas[`${pascal}AccountInfo`];
  if (baseRaw === undefined || infoRaw === undefined) {
    throw providerUnavailable(
      `Lightspark OpenAPI spec has no ${pascal}AccountInfo schema for off-ramp currency ${currency}.`
    );
  }
  const base = openapiAccountBaseSchema.parse(baseRaw);
  const info = openapiAccountInfoSchema.parse(infoRaw);
  const railsEnum = info.allOf.at(-1)?.properties?.paymentRails?.items.enum;
  if (railsEnum === undefined) {
    throw providerUnavailable(`Lightspark ${currency} account schema is missing paymentRails.`);
  }
  const accountTypeValues = base.properties.accountType?.enum;
  if (accountTypeValues === undefined || accountTypeValues.length !== 1) {
    throw providerUnavailable(`Lightspark ${currency} account schema has no accountType enum.`);
  }
  const properties = Object.entries(base.properties).filter(([key]) => key !== "accountType");
  const baseRequired = new Set(base.required !== undefined ? base.required : []);
  const perRail = parsePerRailRequirements(base.description !== undefined ? base.description : "");

  const rails: Record<string, Record<string, RampPayoutFieldSpec>> = {};
  if (perRail === null) {
    const fields = Object.fromEntries(
      properties.map(([key, property]) => [
        key,
        toPayoutField(currency, key, property, baseRequired.has(key)),
      ])
    );
    for (const rail of railsEnum) {
      rails[rail] = fields;
    }
    return { accountType: accountTypeValues[0], rails };
  }

  const railScoped = new Set(Object.values(perRail).flat());
  for (const rail of railsEnum) {
    const listed = perRail[rail];
    if (listed === undefined) {
      throw providerUnavailable(
        `Lightspark ${currency} rail ${rail} is missing from the per-rail requirements description.`
      );
    }
    const unknown = listed.filter((key) => base.properties[key] === undefined);
    if (unknown.length > 0) {
      throw providerUnavailable(
        `Lightspark ${currency} ${rail} description names unknown fields: ${unknown.join(", ")}.`
      );
    }
    rails[rail] = Object.fromEntries(
      properties
        .filter(([key]) => listed.includes(key) || !railScoped.has(key))
        .map(([key, property]) => [
          key,
          toPayoutField(currency, key, property, listed.includes(key)),
        ])
    );
  }
  return { accountType: accountTypeValues[0], rails };
}

/**
 * Distills payout account requirements for each off-ramp currency from the
 * Grid OpenAPI spec. The spec expresses rail-dependent requirements in a
 * strict description format; a format drift fails discovery loudly rather
 * than producing a wrong table.
 *
 * @param openapiRaw - Raw openapi.yaml dump body (YAML text).
 * @param currencies - Off-ramp fiat currencies to distill accounts for.
 * @returns Payout account table keyed by currency.
 */
export function distillLightsparkPayoutAccounts(
  openapiRaw: unknown,
  currencies: readonly string[]
): Record<string, RampPayoutAccountSpec> {
  if (typeof openapiRaw !== "string") {
    throw providerUnavailable("Lightspark OpenAPI dump body must be the YAML text.");
  }
  const schemas = openapiDocSchema.parse(parseYaml(openapiRaw)).components.schemas;
  return Object.fromEntries(
    currencies.map((currency) => [
      currency,
      rampPayoutAccountSchema.parse(distillPayoutAccount(schemas, currency)),
    ])
  );
}

/**
 * Provider entry point for the ramp-support script: fetches both Grid
 * exchange-rate corridor dumps (skipped when offline) and distills them into
 * the rail-support snapshot.
 *
 * @param context - Discovery context supplying env, fetch, and dump access.
 * @returns Distilled snapshot plus dropped currency codes.
 */
export async function discoverLightsparkCurrencyAndRails(
  context: RampDiscoveryContext
): Promise<ProviderRailSupportDistillation> {
  if (!context.offline) {
    const config = readLightsparkConfig(context.env, "sandbox");
    const headers = {
      Authorization: basicAuthHeader(config.tokenId, config.clientSecret),
    };
    await context.writeDump(
      RAMP_RAIL_DUMPS.lightspark.offrampRates.name,
      await context.fetchJson(
        "lightspark",
        `GET /exchange-rates?sourceCurrency=${LIGHTSPARK_DISCOVERY_CRYPTO}`,
        `${config.apiBaseUrl}/exchange-rates?sourceCurrency=${LIGHTSPARK_DISCOVERY_CRYPTO}`,
        { headers }
      )
    );
    await context.writeDump(
      RAMP_RAIL_DUMPS.lightspark.onrampRates.name,
      await context.fetchJson(
        "lightspark",
        `GET /exchange-rates?destinationCurrency=${LIGHTSPARK_DISCOVERY_CRYPTO}`,
        `${config.apiBaseUrl}/exchange-rates?destinationCurrency=${LIGHTSPARK_DISCOVERY_CRYPTO}`,
        { headers }
      )
    );
    await context.writeDump(
      RAMP_RAIL_DUMPS.lightspark.openapi.name,
      await context.fetchText("lightspark", "GET openapi.yaml", LIGHTSPARK_OPENAPI_URL)
    );
  }
  return distillLightsparkRailSupport(
    await context.readDump(RAMP_RAIL_DUMPS.lightspark.offrampRates.file),
    await context.readDump(RAMP_RAIL_DUMPS.lightspark.onrampRates.file),
    await context.readDump(RAMP_RAIL_DUMPS.lightspark.openapi.file)
  );
}
