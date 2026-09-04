import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import {
  type ProviderRailSupportSnapshot,
  providerRailSupportSnapshotSchema,
  RAMP_PROVIDER_CLIENTS,
  type RampDiscoveryResponseDump,
} from "@sdp/payments/ramps";
import { isActiveIso4217CurrencyCode } from "@sdp/payments/ramps/shared";
import { COUNTRY_CODES } from "@sdp/types/countries";
import {
  type CryptoRailId,
  OFFRAMP_CRYPTO_RAILS,
  ONRAMP_CRYPTO_RAILS,
  type RampCountrySupport,
  type RampCurrencyLimit,
  type RampPayoutAccountSpec,
  type RampProviderDirectionSupport,
} from "@sdp/types/payment-rails";
import { RAMP_PROVIDERS, type RampProviderId } from "@sdp/types/provider-access";
import { z } from "zod";

const RAMP_SUPPORT_ROOT_DIR = path.resolve(process.cwd(), ".ramp-support");
const CURRENCY_SUPPORT_RAW_DUMP_DIR = path.join(RAMP_SUPPORT_ROOT_DIR, "raw");
const GENERATED_TARGET = path.resolve(
  process.cwd(),
  "../../packages/sdp-types/src/generated/ramp.generated.ts"
);

const rawDumpSchema = z.object({
  status: z.number(),
  body: z.unknown(),
});

const providerOfframpCountriesSchema = z
  .partialRecord(
    z.enum(COUNTRY_CODES),
    z
      .array(
        z
          .string()
          .regex(/^[A-Z]{3}$/)
          .refine(isActiveIso4217CurrencyCode, "Currency must be an active ISO 4217 code.")
      )
      .nonempty()
  )
  .refine((countries) => Object.keys(countries).length > 0, {
    message: "Provider offramp countries must contain at least one country.",
  });
const rampProviderIdSchema = z.enum(RAMP_PROVIDERS);

type ProviderOfframpCountries = z.infer<typeof providerOfframpCountriesSchema>;

interface OnrampRow {
  source: string;
  dest: CryptoRailId;
  providers: RampProviderId[];
}

interface OfframpRow {
  source: CryptoRailId;
  dest: string;
  providers: RampProviderId[];
}

type ProviderGenerationDirectionSupport = RampProviderDirectionSupport & {
  cryptos: readonly CryptoRailId[];
};

interface ProviderGenerationSupport {
  onramp: ProviderGenerationDirectionSupport;
  offramp: ProviderGenerationDirectionSupport;
}

type CurrencySupportSnapshots = ReadonlyMap<RampProviderId, ProviderRailSupportSnapshot>;
type ProviderGenerationSupports = ReadonlyMap<RampProviderId, ProviderGenerationSupport>;
interface ProviderOfframpCoverage {
  countries: ProviderOfframpCountries;
  swiftExcluded: readonly string[];
}
type OfframpCountriesByProvider = ReadonlyMap<RampProviderId, ProviderOfframpCoverage>;
type PayoutAccountsByProvider = ReadonlyMap<
  RampProviderId,
  Readonly<Record<string, RampPayoutAccountSpec>>
>;

const CURRENCY_DISCOVERY_SUMMARY: Partial<Record<RampProviderId, { ok: number; failed: number }>> =
  {};

function assertNever(value: never): never {
  throw new Error(`Unhandled variant: ${JSON.stringify(value)}`);
}

function currencySupportSnapshotFile(provider: RampProviderId): string {
  return path.join(RAMP_SUPPORT_ROOT_DIR, `${provider}.currency.json`);
}

function isRampProviderId(value: string): value is RampProviderId {
  return RAMP_PROVIDERS.some((provider) => provider === value);
}

function parseProviderArgs(args: readonly string[]): readonly RampProviderId[] {
  const providers: RampProviderId[] = [];
  for (const arg of args) {
    if (arg.startsWith("--")) {
      continue;
    }
    if (!isRampProviderId(arg)) {
      throw new Error(`Unknown ramp provider: ${arg}`);
    }
    providers.push(arg);
  }
  if (providers.length > 0) {
    return providers;
  }
  return [...RAMP_PROVIDERS];
}

function sortCurrencyRecord(
  currencies: Readonly<Record<string, RampCurrencyLimit>>
): Record<string, RampCurrencyLimit> {
  return Object.fromEntries(
    Object.keys(currencies)
      .sort()
      .map((code) => [code, currencies[code]])
  );
}

/**
 * Snapshots record what a provider claims, retired currencies included — their
 * catalogues keep dead codes for years. The generated types are what the
 * platform offers, so the union is filtered here rather than trusting snapshots
 * distilled before a code died. Providers apply the same predicate at distill
 * time, so a refreshed snapshot arrives clean and this drops nothing.
 */
function takeActiveCurrencies(
  provider: RampProviderId,
  directionName: "onramp" | "offramp",
  currencies: Readonly<Record<string, RampCurrencyLimit>>
): Record<string, RampCurrencyLimit> {
  const active: Record<string, RampCurrencyLimit> = {};
  const retired: string[] = [];
  for (const code of Object.keys(currencies)) {
    if (isActiveIso4217CurrencyCode(code)) {
      active[code] = currencies[code];
      continue;
    }
    retired.push(code);
  }
  if (retired.length > 0) {
    console.log(
      `[${provider}] ${directionName}: skipped ${retired.length} inactive ISO 4217 codes in the committed snapshot: ${retired.sort().join(", ")}`
    );
  }
  return active;
}

function sortCountrySupport(countrySupport: RampCountrySupport): RampCountrySupport {
  switch (countrySupport.coverage) {
    case "by-country": {
      const countries: Record<string, readonly string[]> = {};
      for (const countryCode of Object.keys(countrySupport.countries).sort()) {
        countries[countryCode] = [...countrySupport.countries[countryCode]].sort();
      }
      return { coverage: "by-country", countries };
    }
    case "all-currencies":
      return { coverage: "all-currencies", countries: [...countrySupport.countries].sort() };
    case "unreported":
      return { coverage: "unreported" };
    default:
      return assertNever(countrySupport);
  }
}

function sortRecordByKey<TValue>(record: Readonly<Record<string, TValue>>): Record<string, TValue> {
  return Object.fromEntries(
    Object.keys(record)
      .sort()
      .map((key) => [key, record[key]])
  );
}

function sortPayoutAccounts(
  accounts: Readonly<Record<string, RampPayoutAccountSpec>>
): Record<string, RampPayoutAccountSpec> {
  return sortRecordByKey(
    Object.fromEntries(
      Object.entries(accounts).map(([currency, account]) => [
        currency,
        {
          accountType: account.accountType,
          rails: sortRecordByKey(
            Object.fromEntries(
              Object.entries(account.rails).map(([rail, fields]) => [rail, sortRecordByKey(fields)])
            )
          ),
        },
      ])
    )
  );
}

function sortDirectionSnapshot(
  direction: ProviderRailSupportSnapshot["onramp"]
): ProviderRailSupportSnapshot["onramp"] {
  const base: ProviderRailSupportSnapshot["onramp"] = {
    currencies: sortCurrencyRecord(direction.currencies),
    cryptos: [...direction.cryptos].sort(),
  };
  if (direction.countrySupport !== undefined) {
    base.countrySupport = sortCountrySupport(direction.countrySupport);
  }
  if (direction.accounts !== undefined) {
    base.accounts = sortPayoutAccounts(direction.accounts);
  }
  if (direction.swiftAccount !== undefined) {
    base.swiftAccount = sortPayoutAccounts({ SWIFT: direction.swiftAccount }).SWIFT;
  }
  return base;
}

function sortSnapshot(snapshot: ProviderRailSupportSnapshot): ProviderRailSupportSnapshot {
  return {
    onramp: sortDirectionSnapshot(snapshot.onramp),
    offramp: sortDirectionSnapshot(snapshot.offramp),
  };
}

async function writeJsonFile(filePath: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

/**
 * Formats files with the repo's biome so script output is byte-identical to
 * what the pre-commit hook enforces; without this, committed snapshots and the
 * generated file drift purely on formatting.
 */
// Run through node: `pnpm` is a .cmd shim on Windows, which execFileSync cannot spawn.
const biomeCli = createRequire(import.meta.url).resolve("@biomejs/biome/bin/biome");

function biomeFormat(filePaths: readonly string[]): void {
  execFileSync(process.execPath, [biomeCli, "format", "--write", ...filePaths], {
    stdio: "ignore",
  });
}

/**
 * Formats text in memory with the repo's biome config, as if it lived at the
 * given path. Used by the drift check so no scratch file is ever written.
 */
function biomeFormatText(virtualPath: string, text: string): string {
  return execFileSync(process.execPath, [biomeCli, "format", `--stdin-file-path=${virtualPath}`], {
    input: text,
    encoding: "utf8",
  });
}

async function readCurrencySupportRawDump(relativePath: string): Promise<unknown> {
  const file = path.join(CURRENCY_SUPPORT_RAW_DUMP_DIR, relativePath);
  const text = await readFile(file, "utf8");
  const parsed: unknown = JSON.parse(text);
  const dump = rawDumpSchema.parse(parsed);
  if (dump.status < 200 || dump.status >= 300) {
    throw new Error(`Raw dump ${relativePath} returned status ${dump.status}.`);
  }
  return dump.body;
}

async function readCurrencySupportSnapshot(
  provider: RampProviderId
): Promise<ProviderRailSupportSnapshot> {
  const text = await readFile(currencySupportSnapshotFile(provider), "utf8");
  const parsed: unknown = JSON.parse(text);
  return providerRailSupportSnapshotSchema.parse(parsed);
}

async function readCurrencySupportSnapshots(): Promise<CurrencySupportSnapshots> {
  const loaded = await Promise.all(
    RAMP_PROVIDERS.map(async (provider) => ({
      provider,
      snapshot: await readCurrencySupportSnapshot(provider),
    }))
  );
  const snapshots = new Map<RampProviderId, ProviderRailSupportSnapshot>();
  for (const entry of loaded) {
    snapshots.set(entry.provider, entry.snapshot);
  }
  return snapshots;
}

/**
 * Reads and validates every hand-compiled provider country-rails table.
 *
 * @returns Validated country, currency, and rail mappings keyed by provider.
 */
async function readOfframpCountriesByProvider(): Promise<OfframpCountriesByProvider> {
  const entries = await readdir(RAMP_SUPPORT_ROOT_DIR, { withFileTypes: true });
  const byProvider = new Map<RampProviderId, ProviderOfframpCoverage>();
  const sortedEntries = entries.sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of sortedEntries) {
    if (!entry.isFile() || !entry.name.endsWith(".countries.json")) {
      continue;
    }
    const providerName = entry.name.slice(0, -".countries.json".length);
    const provider = rampProviderIdSchema.parse(providerName);
    const text = await readFile(path.join(RAMP_SUPPORT_ROOT_DIR, entry.name), "utf8");
    const parsed = z
      .object({
        $comment: z.string(),
        swiftExcluded: z.array(z.enum(COUNTRY_CODES)),
        countries: providerOfframpCountriesSchema,
      })
      .parse(JSON.parse(text));
    byProvider.set(provider, {
      countries: parsed.countries,
      swiftExcluded: parsed.swiftExcluded,
    });
  }
  return byProvider;
}

/**
 * Derives generic offramp country support from a provider's hand-compiled country table.
 *
 * @param offrampCountries - Validated country-to-currencies coverage.
 * @returns Country support for the generic generated provider metadata.
 */
function compiledOfframpCountrySupport(
  offrampCountries: ProviderOfframpCountries
): RampCountrySupport {
  const countries: Record<string, readonly string[]> = {};
  for (const countryCode of [...COUNTRY_CODES].sort()) {
    const currencies = offrampCountries[countryCode];
    if (currencies === undefined) {
      continue;
    }
    countries[countryCode] = [...currencies].sort();
  }
  return { coverage: "by-country", countries };
}

function mergeDirectionSupport(
  provider: RampProviderId,
  directionName: "onramp" | "offramp",
  snapshot: ProviderRailSupportSnapshot["onramp"],
  declared: (typeof RAMP_PROVIDER_CLIENTS)[RampProviderId]["declaredRailSupport"]["onramp"],
  compiledCountrySupport?: RampCountrySupport
): ProviderGenerationDirectionSupport {
  const countrySupportSources: Array<{
    provenance: "compiled" | "declared" | "discovered";
    value: RampCountrySupport;
  }> = [];
  if (snapshot.countrySupport !== undefined) {
    countrySupportSources.push({ provenance: "discovered", value: snapshot.countrySupport });
  }
  if (declared.countrySupport !== undefined) {
    countrySupportSources.push({ provenance: "declared", value: declared.countrySupport });
  }
  if (compiledCountrySupport !== undefined) {
    countrySupportSources.push({ provenance: "compiled", value: compiledCountrySupport });
  }
  if (countrySupportSources.length !== 1) {
    const provenances = countrySupportSources.map((source) => source.provenance);
    const provenanceSummary = provenances.length === 0 ? "none" : provenances.join(", ");
    throw new Error(
      `${provider} ${directionName} country support requires exactly one provenance; found ${provenanceSummary}.`
    );
  }
  const countrySupportSource = countrySupportSources[0];
  if (countrySupportSource === undefined) {
    throw new Error(`${provider} ${directionName} country support is missing.`);
  }

  const currencies = takeActiveCurrencies(provider, directionName, snapshot.currencies);
  const hasCurrencies = Object.keys(currencies).length > 0;
  const hasCryptos = snapshot.cryptos.length > 0;
  if ((hasCurrencies || hasCryptos) && declared.entityTypes.length === 0) {
    throw new Error(`${provider} ${directionName} has rails but no declared entity types.`);
  }

  return {
    currencies: sortCurrencyRecord(currencies),
    cryptos: [...snapshot.cryptos].sort(),
    countrySupport: sortCountrySupport(countrySupportSource.value),
    entityTypes: [...declared.entityTypes].sort(),
  };
}

function mergeProviderSupport(
  provider: RampProviderId,
  snapshot: ProviderRailSupportSnapshot,
  offrampCoverage?: ProviderOfframpCoverage
): ProviderGenerationSupport {
  const declared = RAMP_PROVIDER_CLIENTS[provider].declaredRailSupport;
  const compiledCountrySupport =
    offrampCoverage === undefined
      ? undefined
      : compiledOfframpCountrySupport(offrampCoverage.countries);
  return {
    onramp: mergeDirectionSupport(provider, "onramp", snapshot.onramp, declared.onramp),
    offramp: mergeDirectionSupport(
      provider,
      "offramp",
      snapshot.offramp,
      declared.offramp,
      compiledCountrySupport
    ),
  };
}

/**
 * Reads one required provider snapshot from the complete snapshot map.
 *
 * @param snapshots - Currency-support snapshots keyed by provider.
 * @param provider - Provider whose snapshot is required.
 * @returns The provider snapshot.
 */
function requireProviderSnapshot(
  snapshots: CurrencySupportSnapshots,
  provider: RampProviderId
): ProviderRailSupportSnapshot {
  const snapshot = snapshots.get(provider);
  if (snapshot === undefined) {
    throw new Error(`Missing currency-support snapshot for ${provider}.`);
  }
  return snapshot;
}

/**
 * Reads one required provider support entry from the generated support map.
 *
 * @param support - Generated support keyed by provider.
 * @param provider - Provider whose support is required.
 * @returns The provider support entry.
 */
function requireProviderSupport(
  support: ProviderGenerationSupports,
  provider: RampProviderId
): ProviderGenerationSupport {
  const providerSupport = support.get(provider);
  if (providerSupport === undefined) {
    throw new Error(`Missing generated ramp support for ${provider}.`);
  }
  return providerSupport;
}

function buildProviderSupport(
  snapshots: CurrencySupportSnapshots,
  offrampCountriesByProvider: OfframpCountriesByProvider
): ProviderGenerationSupports {
  const support = new Map<RampProviderId, ProviderGenerationSupport>();
  for (const provider of RAMP_PROVIDERS) {
    const snapshot = requireProviderSnapshot(snapshots, provider);
    const offrampCoverage = offrampCountriesByProvider.get(provider);
    support.set(provider, mergeProviderSupport(provider, snapshot, offrampCoverage));
  }
  return support;
}

function buildOnrampMatrix(support: ProviderGenerationSupports): OnrampRow[] {
  const rows: OnrampRow[] = [];
  const allFiats = new Set<string>();
  for (const provider of RAMP_PROVIDERS) {
    const currencies = requireProviderSupport(support, provider).onramp.currencies;
    for (const fiat of Object.keys(currencies)) {
      allFiats.add(fiat);
    }
  }

  for (const source of [...allFiats].sort()) {
    for (const dest of ONRAMP_CRYPTO_RAILS) {
      const providers: RampProviderId[] = [];
      for (const provider of RAMP_PROVIDERS) {
        const providerSupport = requireProviderSupport(support, provider).onramp;
        if (
          Object.hasOwn(providerSupport.currencies, source) &&
          providerSupport.cryptos.includes(dest)
        ) {
          providers.push(provider);
        }
      }
      if (providers.length > 0) {
        rows.push({ source, dest, providers });
      }
    }
  }
  return rows;
}

function buildOfframpMatrix(support: ProviderGenerationSupports): OfframpRow[] {
  const rows: OfframpRow[] = [];
  const allFiats = new Set<string>();
  for (const provider of RAMP_PROVIDERS) {
    const currencies = requireProviderSupport(support, provider).offramp.currencies;
    for (const fiat of Object.keys(currencies)) {
      allFiats.add(fiat);
    }
  }

  for (const source of OFFRAMP_CRYPTO_RAILS) {
    for (const dest of [...allFiats].sort()) {
      const providers: RampProviderId[] = [];
      for (const provider of RAMP_PROVIDERS) {
        const providerSupport = requireProviderSupport(support, provider).offramp;
        if (
          providerSupport.cryptos.includes(source) &&
          Object.hasOwn(providerSupport.currencies, dest)
        ) {
          providers.push(provider);
        }
      }
      if (providers.length > 0) {
        rows.push({ source, dest, providers });
      }
    }
  }
  return rows;
}

function collectCountryCodes(support: ProviderGenerationSupports): string[] {
  const countryCodes = new Set<string>();
  for (const provider of RAMP_PROVIDERS) {
    const providerSupport = requireProviderSupport(support, provider);
    for (const direction of [providerSupport.onramp, providerSupport.offramp]) {
      switch (direction.countrySupport.coverage) {
        case "by-country":
          for (const countryCode of Object.keys(direction.countrySupport.countries)) {
            countryCodes.add(countryCode);
          }
          break;
        case "all-currencies":
          for (const countryCode of direction.countrySupport.countries) {
            countryCodes.add(countryCode);
          }
          break;
        case "unreported":
          break;
        default:
          assertNever(direction.countrySupport);
      }
    }
  }
  return [...countryCodes].sort();
}

function sha256Json(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function renderRows(rows: readonly Array<OnrampRow | OfframpRow>): string {
  return rows
    .map((row) => {
      const renderedProviders = row.providers
        .map((provider) => JSON.stringify(provider))
        .join(", ");
      const inline = `  { source: ${JSON.stringify(row.source)}, dest: ${JSON.stringify(row.dest)}, providers: [${renderedProviders}] },`;
      if (inline.length <= 100) {
        return inline;
      }
      return `  {
    source: ${JSON.stringify(row.source)},
    dest: ${JSON.stringify(row.dest)},
    providers: [${renderedProviders}],
  },`;
    })
    .join("\n");
}

function renderProviderHashes(hashes: ReadonlyMap<RampProviderId, string>): string {
  return `{\n${RAMP_PROVIDERS.map((provider) => {
    const hash = hashes.get(provider);
    if (hash === undefined) {
      throw new Error(`Missing support hash for ${provider}.`);
    }
    return `  // biome-ignore lint/security/noSecrets: deterministic support hash, not a secret.\n  ${provider}: ${JSON.stringify(hash)},`;
  }).join("\n")}\n}`;
}

function pairCount(direction: ProviderGenerationDirectionSupport): number {
  return Object.keys(direction.currencies).length * direction.cryptos.length;
}

function renderProviderCounts(support: ProviderGenerationSupports): string {
  return `{\n${RAMP_PROVIDERS.map((provider) => {
    const providerSupport = requireProviderSupport(support, provider);
    return `  ${provider}: { onramp: ${pairCount(providerSupport.onramp)}, offramp: ${pairCount(providerSupport.offramp)} },`;
  }).join("\n")}\n}`;
}

function indent(level: number): string {
  return " ".repeat(level);
}

function renderIndentedStringArray(values: readonly string[], level: number): string {
  if (values.length === 0) {
    return "[]";
  }
  const pad = indent(level);
  return `[\n${values.map((value) => `${pad}  ${JSON.stringify(value)},`).join("\n")}\n${pad}]`;
}

function renderInlineStringArray(values: readonly string[]): string {
  return `[${values.map((value) => JSON.stringify(value)).join(", ")}]`;
}

function renderCurrencyLimits(
  currencies: Readonly<Record<string, RampCurrencyLimit>>,
  level: number
): string {
  const keys = Object.keys(currencies).sort();
  if (keys.length === 0) {
    return "{}";
  }
  const pad = indent(level);
  return `{\n${keys
    .map((code) => {
      const limit = currencies[code];
      return `${pad}  ${code}: { min: ${JSON.stringify(limit.min)}, max: ${JSON.stringify(limit.max)} },`;
    })
    .join("\n")}\n${pad}}`;
}

function renderCountryCurrencyRecord(
  countries: Readonly<Record<string, readonly string[]>>,
  level: number
): string {
  const keys = Object.keys(countries).sort();
  if (keys.length === 0) {
    return "{}";
  }
  const pad = indent(level);
  return `{\n${keys
    .map((countryCode) => {
      const currencies = [...countries[countryCode]].sort();
      return `${pad}  ${countryCode}: ${renderInlineStringArray(currencies)},`;
    })
    .join("\n")}\n${pad}}`;
}

function renderCountrySupport(countrySupport: RampCountrySupport, level: number): string {
  const pad = indent(level);
  switch (countrySupport.coverage) {
    case "by-country":
      return `{\n${pad}  coverage: "by-country",\n${pad}  countries: ${renderCountryCurrencyRecord(countrySupport.countries, level + 2)},\n${pad}}`;
    case "all-currencies":
      return `{\n${pad}  coverage: "all-currencies",\n${pad}  countries: ${renderIndentedStringArray(countrySupport.countries, level + 2)},\n${pad}}`;
    case "unreported":
      return `{ coverage: "unreported" }`;
    default:
      return assertNever(countrySupport);
  }
}

function renderDirectionDetails(
  direction: ProviderGenerationDirectionSupport,
  level: number
): string {
  const pad = indent(level);
  return `{\n${pad}  currencies: ${renderCurrencyLimits(direction.currencies, level + 2)},\n${pad}  countrySupport: ${renderCountrySupport(direction.countrySupport, level + 2)},\n${pad}  entityTypes: ${renderInlineStringArray(direction.entityTypes)},\n${pad}}`;
}

function renderProviderSupportDetails(support: ProviderGenerationSupports): string {
  return `{\n${RAMP_PROVIDERS.map((provider) => {
    const providerSupport = requireProviderSupport(support, provider);
    return `  ${provider}: {\n    onramp: ${renderDirectionDetails(providerSupport.onramp, 4)},\n    offramp: ${renderDirectionDetails(providerSupport.offramp, 4)},\n  },`;
  }).join("\n")}\n}`;
}

function renderPayoutAccounts(payoutAccountsByProvider: PayoutAccountsByProvider): string {
  const rows: string[] = [];
  for (const provider of RAMP_PROVIDERS) {
    const accounts = payoutAccountsByProvider.get(provider);
    if (accounts === undefined) {
      continue;
    }
    const rendered = JSON.stringify(accounts, null, 2)
      .split("\n")
      .map((line, index) => (index === 0 ? line : `  ${line}`))
      .join("\n");
    rows.push(`  ${provider}: ${rendered},`);
  }
  if (rows.length === 0) {
    return "{}";
  }
  return `{\n${rows.join("\n")}\n}`;
}

function renderSwiftSupport(
  snapshots: CurrencySupportSnapshots,
  offrampCountriesByProvider: OfframpCountriesByProvider
): string {
  const rows: string[] = [];
  for (const provider of RAMP_PROVIDERS) {
    const swiftAccount = snapshots.get(provider)?.offramp.swiftAccount;
    if (swiftAccount === undefined) {
      continue;
    }
    const coverage = offrampCountriesByProvider.get(provider);
    if (coverage === undefined) {
      throw new Error(
        `${provider} snapshot has a SWIFT account but no hand-compiled country coverage to scope it.`
      );
    }
    const entry = {
      account: swiftAccount,
      excludedCountries: [...coverage.swiftExcluded].sort(),
    };
    const rendered = JSON.stringify(entry, null, 2)
      .split("\n")
      .map((line, index) => (index === 0 ? line : `  ${line}`))
      .join("\n");
    rows.push(`  ${provider}: ${rendered},`);
  }
  if (rows.length === 0) {
    return "{}";
  }
  return `{\n${rows.join("\n")}\n}`;
}

function renderGeneratedFile(input: {
  support: ProviderGenerationSupports;
  onrampRows: readonly OnrampRow[];
  offrampRows: readonly OfframpRow[];
  payoutAccountsByProvider: PayoutAccountsByProvider;
  swiftSupport: string;
}): string {
  const allFiats = new Set<string>();
  for (const row of input.onrampRows) {
    allFiats.add(row.source);
  }
  for (const row of input.offrampRows) {
    allFiats.add(row.dest);
  }
  const fiatCurrencies = [...allFiats].sort();
  const onrampSourceCurrencies = [...new Set(input.onrampRows.map((row) => row.source))].sort();
  const offrampDestinationCurrencies = [
    ...new Set(input.offrampRows.map((row) => row.dest)),
  ].sort();
  const countryCodes = collectCountryCodes(input.support);
  const providerHashes = new Map<RampProviderId, string>();
  const supportHashInput: Partial<Record<RampProviderId, ProviderGenerationSupport>> = {};
  for (const provider of RAMP_PROVIDERS) {
    const providerSupport = requireProviderSupport(input.support, provider);
    providerHashes.set(provider, sha256Json(providerSupport));
    supportHashInput[provider] = providerSupport;
  }
  const supportHash = sha256Json(supportHashInput);

  return `// AUTO-GENERATED - do not edit by hand.
// Refresh raw dumps and snapshots: pnpm --filter @sdp/api currencies:discover
// Regenerate support: pnpm --filter @sdp/api ramp-support:generate
// Raw dumps live in apps/sdp-api/.ramp-support/raw/ (gitignored).
// Currency-support snapshots live in apps/sdp-api/.ramp-support/*.currency.json (committed).
// Offramp country coverage lives in apps/sdp-api/.ramp-support/*.countries.json (hand-compiled).

import type {
  OfframpPairSupport,
  OnrampPairSupport,
  RampPayoutAccountSpec,
  RampProviderDirectionSupport,
} from "../payment-rails";
import type { RampProviderId } from "../provider-access";

export const RAMP_SUPPORT_HASH =
  // biome-ignore lint/security/noSecrets: deterministic support hash, not a secret.
  ${JSON.stringify(supportHash)} as const;

export const RAMP_PROVIDER_SUPPORT_HASHES = ${renderProviderHashes(providerHashes)} as const satisfies Record<RampProviderId, string>;

export const RAMP_PROVIDER_SUPPORT_COUNTS = ${renderProviderCounts(input.support)} as const satisfies Record<RampProviderId, { onramp: number; offramp: number }>;

export const RAMP_FIAT_CURRENCIES = ${renderIndentedStringArray(fiatCurrencies, 0)} as const;
export type RampFiatCurrency = (typeof RAMP_FIAT_CURRENCIES)[number];

export const RAMP_COUNTRY_CODES = ${renderIndentedStringArray(countryCodes, 0)} as const;
export type RampCountryCode = (typeof RAMP_COUNTRY_CODES)[number];

export const ONRAMP_SOURCE_CURRENCIES = ${renderIndentedStringArray(onrampSourceCurrencies, 0)} as const satisfies readonly RampFiatCurrency[];
export type OnrampSourceCurrency = (typeof ONRAMP_SOURCE_CURRENCIES)[number];

export const OFFRAMP_DESTINATION_CURRENCIES = ${renderIndentedStringArray(offrampDestinationCurrencies, 0)} as const satisfies readonly RampFiatCurrency[];
export type OfframpDestinationCurrency = (typeof OFFRAMP_DESTINATION_CURRENCIES)[number];

export const OFFRAMP_PAYOUT_ACCOUNTS = ${renderPayoutAccounts(input.payoutAccountsByProvider)} as const satisfies Partial<
  Record<RampProviderId, Record<string, RampPayoutAccountSpec>>
>;

export const OFFRAMP_SWIFT_SUPPORT = ${input.swiftSupport} as const satisfies Partial<
  Record<RampProviderId, { account: RampPayoutAccountSpec; excludedCountries: readonly string[] }>
>;

export const RAMP_PROVIDER_SUPPORT_DETAILS = ${renderProviderSupportDetails(input.support)} as const satisfies Record<
  RampProviderId,
  {
    onramp: RampProviderDirectionSupport;
    offramp: RampProviderDirectionSupport;
  }
>;

export const ONRAMP_SUPPORT = [
${renderRows(input.onrampRows)}
] as const satisfies readonly OnrampPairSupport<RampFiatCurrency>[];

export const OFFRAMP_SUPPORT = [
${renderRows(input.offrampRows)}
] as const satisfies readonly OfframpPairSupport<RampFiatCurrency>[];
`;
}

/**
 * Collects each provider's distilled payout-account table and enforces that
 * every currency named by a hand-compiled country-rails row has an account
 * spec — the contradiction class where the country table advertises a payout
 * the provider cannot address.
 */
function buildPayoutAccounts(
  snapshots: CurrencySupportSnapshots,
  offrampCountriesByProvider: OfframpCountriesByProvider
): PayoutAccountsByProvider {
  const byProvider = new Map<RampProviderId, Readonly<Record<string, RampPayoutAccountSpec>>>();
  for (const provider of RAMP_PROVIDERS) {
    const accounts = snapshots.get(provider)?.offramp.accounts;
    if (accounts === undefined) {
      continue;
    }
    byProvider.set(provider, accounts);
    const offrampCoverage = offrampCountriesByProvider.get(provider);
    if (offrampCoverage === undefined) {
      continue;
    }
    for (const [countryCode, currencies] of Object.entries(offrampCoverage.countries)) {
      for (const currency of currencies) {
        if (accounts[currency] === undefined) {
          throw new Error(
            `${provider} offramp countries list ${currency} for ${countryCode}, but the snapshot has no payout account spec for it.`
          );
        }
      }
    }
  }
  return byProvider;
}

async function renderGeneratedFromSnapshots(): Promise<string> {
  const [snapshots, offrampCountriesByProvider] = await Promise.all([
    currencySupport.readSnapshots(),
    offrampCountries.readByProvider(),
  ]);
  const support = buildProviderSupport(snapshots, offrampCountriesByProvider);
  return renderGeneratedFile({
    support,
    onrampRows: buildOnrampMatrix(support),
    offrampRows: buildOfframpMatrix(support),
    payoutAccountsByProvider: buildPayoutAccounts(snapshots, offrampCountriesByProvider),
    swiftSupport: renderSwiftSupport(snapshots, offrampCountriesByProvider),
  });
}

async function writeCurrencySupportDump(
  name: string,
  payload: RampDiscoveryResponseDump
): Promise<void> {
  await writeJsonFile(path.join(CURRENCY_SUPPORT_RAW_DUMP_DIR, `${name}.json`), payload);
}

function providerSummary(provider: RampProviderId): { ok: number; failed: number } {
  const existing = CURRENCY_DISCOVERY_SUMMARY[provider];
  if (existing !== undefined) {
    return existing;
  }
  const created = { ok: 0, failed: 0 };
  CURRENCY_DISCOVERY_SUMMARY[provider] = created;
  return created;
}

async function fetchJson(
  provider: RampProviderId,
  label: string,
  url: string,
  init?: RequestInit
): Promise<RampDiscoveryResponseDump> {
  const response = init === undefined ? await fetch(url) : await fetch(url, init);
  const text = await response.text();
  const body: unknown = JSON.parse(text);
  const summary = providerSummary(provider);

  if (response.ok) {
    summary.ok += 1;
    console.log(`  ok ${label} (${response.status})`);
  } else {
    summary.failed += 1;
    console.warn(`  failed ${label} (${response.status})`);
  }

  return { status: response.status, body };
}

async function fetchText(
  provider: RampProviderId,
  label: string,
  url: string
): Promise<RampDiscoveryResponseDump> {
  const response = await fetch(url);
  const body = await response.text();
  const summary = providerSummary(provider);

  if (response.ok) {
    summary.ok += 1;
    console.log(`  ok ${label} (${response.status})`);
  } else {
    summary.failed += 1;
    console.warn(`  failed ${label} (${response.status})`);
  }

  return { status: response.status, body };
}

function logDroppedCurrencyCodes(provider: RampProviderId, codes: readonly string[]): void {
  if (codes.length === 0) {
    return;
  }
  console.log(`[${provider}] dropped ${codes.length} inactive ISO 4217 codes: ${codes.join(", ")}`);
}

function logDroppedCountryCodes(provider: RampProviderId, codes: readonly string[]): void {
  if (codes.length === 0) {
    return;
  }
  console.log(
    `[${provider}] dropped ${codes.length} invalid ISO 3166-1 alpha-2 codes: ${codes.join(", ")}`
  );
}

async function writeCurrencySnapshot(
  provider: RampProviderId,
  distillation: ProviderRailSupportDistillation
): Promise<void> {
  const snapshot = sortSnapshot(distillation.snapshot);
  await writeJsonFile(currencySupportSnapshotFile(provider), snapshot);
  biomeFormat([currencySupportSnapshotFile(provider)]);
  logDroppedCurrencyCodes(provider, distillation.droppedCurrencyCodes);
  logDroppedCountryCodes(provider, distillation.droppedCountryCodes);
  console.log(
    `[${provider}] wrote ${path.relative(process.cwd(), currencySupportSnapshotFile(provider))}: onramp ${Object.keys(snapshot.onramp.currencies).length} fiat x ${snapshot.onramp.cryptos.length} crypto; offramp ${snapshot.offramp.cryptos.length} crypto x ${Object.keys(snapshot.offramp.currencies).length} fiat`
  );
}

async function runCurrencyDiscovery(args: readonly string[]): Promise<void> {
  const offline = args.includes("--offline");
  const selectedProviders = parseProviderArgs(args);
  await mkdir(CURRENCY_SUPPORT_RAW_DUMP_DIR, { recursive: true });

  if (!offline) {
    console.log(
      `Currency-support raw dump dir: ${path.relative(process.cwd(), CURRENCY_SUPPORT_RAW_DUMP_DIR)}`
    );
  }

  const failedProviders: string[] = [];
  for (const provider of selectedProviders) {
    if (!offline) {
      console.log(`\n[${provider}] fetch`);
    }
    const distillation = await RAMP_PROVIDER_CLIENTS[provider].discoverCurrencyAndRails({
      env: process.env,
      fetchJson,
      fetchText,
      writeDump: writeCurrencySupportDump,
      readDump: readCurrencySupportRawDump,
      offline,
    });
    const stats = CURRENCY_DISCOVERY_SUMMARY[provider];
    if (stats !== undefined && stats.failed > 0) {
      failedProviders.push(`${provider} (${stats.failed} failed)`);
      continue;
    }
    await writeCurrencySnapshot(provider, distillation);
  }

  if (!offline) {
    console.log("\nFetch summary:");
    for (const provider of RAMP_PROVIDERS) {
      const stats = CURRENCY_DISCOVERY_SUMMARY[provider];
      if (stats !== undefined) {
        console.log(`  ${provider}: ${stats.ok} ok, ${stats.failed} failed`);
      }
    }
  }
  if (failedProviders.length > 0) {
    throw new Error(
      `Currency-support discovery had failed requests: ${failedProviders.join(", ")}.`
    );
  }
}

const currencySupport = {
  discover: runCurrencyDiscovery,
  readSnapshots: readCurrencySupportSnapshots,
} as const satisfies {
  discover: (args: readonly string[]) => Promise<void>;
  readSnapshots: () => Promise<CurrencySupportSnapshots>;
};

const offrampCountries = {
  readByProvider: readOfframpCountriesByProvider,
} as const satisfies {
  readByProvider: () => Promise<OfframpCountriesByProvider>;
};

async function runGenerate(): Promise<void> {
  const rendered = await renderGeneratedFromSnapshots();
  await mkdir(path.dirname(GENERATED_TARGET), { recursive: true });
  await writeFile(GENERATED_TARGET, rendered, "utf8");
  biomeFormat([GENERATED_TARGET]);
  console.log(`Wrote ${path.relative(process.cwd(), GENERATED_TARGET)}.`);
}

function summarizeSourceDiff(expected: string, actual: string): string[] {
  const expectedLines = expected.split("\n");
  const actualLines = actual.split("\n");
  const maxLines = Math.max(expectedLines.length, actualLines.length);
  const summary: string[] = [];
  for (let index = 0; index < maxLines; index += 1) {
    const expectedLine = expectedLines[index];
    const actualLine = actualLines[index];
    if (expectedLine === actualLine) {
      continue;
    }
    const lineNumber = index + 1;
    summary.push(
      `line ${lineNumber}: expected ${JSON.stringify(expectedLine)}; found ${JSON.stringify(actualLine)}`
    );
    if (summary.length === 12) {
      break;
    }
  }
  return summary;
}

async function runDrift(): Promise<void> {
  const rendered = await renderGeneratedFromSnapshots();
  const expected = biomeFormatText(GENERATED_TARGET, rendered);
  const actual = await readFile(GENERATED_TARGET, "utf8");
  if (expected === actual) {
    console.log("No ramp support drift detected.");
    return;
  }

  console.error(
    "Ramp support drift detected. Generated file differs from committed support sources."
  );
  for (const line of summarizeSourceDiff(expected, actual)) {
    console.error(`  ${line}`);
  }
  process.exitCode = 1;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const command = args[0];
  if (command === undefined) {
    throw new Error(
      "Usage: ramp-support.ts <discover-currencies|generate|drift> [provider...] [--offline]"
    );
  }
  const commandArgs = args.slice(1);
  switch (command) {
    case "discover-currencies":
      await currencySupport.discover(commandArgs);
      break;
    case "generate":
      await runGenerate();
      break;
    case "drift":
      await runDrift();
      break;
    default:
      throw new Error(`Unknown ramp support command: ${command}`);
  }
}

void main();
