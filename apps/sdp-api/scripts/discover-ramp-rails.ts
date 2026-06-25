import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  type CryptoRailId,
  type FiatCurrencyCode,
  OFFRAMP_CRYPTO_RAILS,
  ONRAMP_CRYPTO_RAILS,
} from "@sdp/types/payment-rails";
import { RAMP_PROVIDERS, type RampProviderId } from "@sdp/types/provider-access";

import {
  type ProviderRampSupport,
  RampClient,
  type RampDiscoveryResponseDump,
} from "../src/lib/ramps";

const OUTPUT_DIR = path.resolve(process.cwd(), ".ramp-rails");
const EMIT_TARGET = path.resolve(
  process.cwd(),
  "../../packages/sdp-types/src/generated/ramp-support.generated.ts"
);

const rampClient = new RampClient();

async function readDump<T>(relativePath: string): Promise<T> {
  const file = path.join(OUTPUT_DIR, relativePath);
  const text = await readFile(file, "utf8");
  const parsed = JSON.parse(text) as { status?: number; body: T };
  if (typeof parsed.status === "number" && (parsed.status < 200 || parsed.status >= 300)) {
    throw new Error(`dump status ${parsed.status}`);
  }
  return parsed.body;
}

interface OnrampRow {
  source: FiatCurrencyCode;
  dest: CryptoRailId;
  providers: RampProviderId[];
}

interface OfframpRow {
  source: CryptoRailId;
  dest: FiatCurrencyCode;
  providers: RampProviderId[];
}

interface ProviderOnrampPair {
  source: FiatCurrencyCode;
  dest: CryptoRailId;
}

interface ProviderOfframpPair {
  source: CryptoRailId;
  dest: FiatCurrencyCode;
}

interface ProviderSupportSnapshot {
  onramp: ProviderOnrampPair[];
  offramp: ProviderOfframpPair[];
}

function buildOnrampMatrix(bySupport: Record<RampProviderId, ProviderRampSupport>): OnrampRow[] {
  const rows: OnrampRow[] = [];
  const allFiats = new Set<FiatCurrencyCode>();
  for (const support of Object.values(bySupport)) {
    for (const fiat of support.onrampFiats) allFiats.add(fiat);
  }

  const sortedFiats = [...allFiats].sort();
  for (const source of sortedFiats) {
    for (const dest of ONRAMP_CRYPTO_RAILS) {
      const providers: RampProviderId[] = [];
      for (const provider of RAMP_PROVIDERS) {
        const support = bySupport[provider];
        if (support.onrampFiats.has(source) && support.onrampCryptos.has(dest)) {
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

function buildOfframpMatrix(bySupport: Record<RampProviderId, ProviderRampSupport>): OfframpRow[] {
  const rows: OfframpRow[] = [];
  const allFiats = new Set<FiatCurrencyCode>();
  for (const support of Object.values(bySupport)) {
    for (const fiat of support.offrampFiats) allFiats.add(fiat);
  }

  const sortedFiats = [...allFiats].sort();
  for (const source of OFFRAMP_CRYPTO_RAILS) {
    for (const dest of sortedFiats) {
      const providers: RampProviderId[] = [];
      for (const provider of RAMP_PROVIDERS) {
        const support = bySupport[provider];
        if (support.offrampCryptos.has(source) && support.offrampFiats.has(dest)) {
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

function buildProviderSupportSnapshots(
  bySupport: Record<RampProviderId, ProviderRampSupport>
): Record<RampProviderId, ProviderSupportSnapshot> {
  const entries = RAMP_PROVIDERS.map((provider) => {
    const support = bySupport[provider];
    const onramp: ProviderOnrampPair[] = [];
    const offramp: ProviderOfframpPair[] = [];

    for (const source of [...support.onrampFiats].sort()) {
      for (const dest of ONRAMP_CRYPTO_RAILS) {
        if (support.onrampCryptos.has(dest)) onramp.push({ source, dest });
      }
    }

    for (const source of OFFRAMP_CRYPTO_RAILS) {
      if (!support.offrampCryptos.has(source)) continue;
      for (const dest of [...support.offrampFiats].sort()) {
        offramp.push({ source, dest });
      }
    }

    return [provider, { onramp, offramp }] as const;
  });

  return Object.fromEntries(entries) as Record<RampProviderId, ProviderSupportSnapshot>;
}

function sha256Json(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function renderRows(rows: readonly Array<OnrampRow | OfframpRow>): string {
  return rows
    .map(
      (row) =>
        `  { source: ${JSON.stringify(row.source)}, dest: ${JSON.stringify(row.dest)}, providers: [${row.providers.map((p) => JSON.stringify(p)).join(", ")}] },`
    )
    .join("\n");
}

function renderStringArray(values: readonly string[]): string {
  if (values.length === 0) return "[]";
  return `[\n${values.map((value) => `  ${JSON.stringify(value)},`).join("\n")}\n]`;
}

function renderProviderHashes(hashes: Record<RampProviderId, string>): string {
  return `{\n${RAMP_PROVIDERS.map((provider) => `  // biome-ignore lint/security/noSecrets: deterministic support hash, not a secret.\n  ${provider}: ${JSON.stringify(hashes[provider])},`).join("\n")}\n}`;
}

function renderProviderCounts(snapshots: Record<RampProviderId, ProviderSupportSnapshot>): string {
  return `{\n${RAMP_PROVIDERS.map((provider) => {
    const snapshot = snapshots[provider];
    return `  ${provider}: { onramp: ${snapshot.onramp.length}, offramp: ${snapshot.offramp.length} },`;
  }).join("\n")}\n}`;
}

function renderGeneratedFile(input: {
  onrampRows: readonly OnrampRow[];
  offrampRows: readonly OfframpRow[];
  providerSnapshots: Record<RampProviderId, ProviderSupportSnapshot>;
}): string {
  const allFiats = new Set<FiatCurrencyCode>();
  for (const row of input.onrampRows) allFiats.add(row.source);
  for (const row of input.offrampRows) allFiats.add(row.dest);
  const fiatCurrencies = [...allFiats].sort();
  const onrampSourceCurrencies = [...new Set(input.onrampRows.map((row) => row.source))].sort();
  const offrampDestinationCurrencies = [
    ...new Set(input.offrampRows.map((row) => row.dest)),
  ].sort();
  const providerHashes = Object.fromEntries(
    RAMP_PROVIDERS.map((provider) => [provider, sha256Json(input.providerSnapshots[provider])])
  ) as Record<RampProviderId, string>;
  const supportHash = sha256Json(input.providerSnapshots);

  return `// AUTO-GENERATED - do not edit by hand.
// Refresh dumps + regenerate:   pnpm --filter @sdp/api rails:discover --emit
// Regenerate from existing dumps: pnpm --filter @sdp/api rails:generate
// Source dumps live in apps/sdp-api/.ramp-rails/ (committed).

import type { OfframpPairSupport, OnrampPairSupport } from "../payment-rails";
import type { RampProviderId } from "../provider-access";

export const RAMP_SUPPORT_HASH =
  // biome-ignore lint/security/noSecrets: deterministic support hash, not a secret.
  ${JSON.stringify(supportHash)} as const;

export const RAMP_PROVIDER_SUPPORT_HASHES = ${renderProviderHashes(providerHashes)} as const satisfies Record<RampProviderId, string>;

export const RAMP_PROVIDER_SUPPORT_COUNTS = ${renderProviderCounts(input.providerSnapshots)} as const satisfies Record<RampProviderId, { onramp: number; offramp: number }>;

export const RAMP_FIAT_CURRENCIES = ${renderStringArray(fiatCurrencies)} as const;
export type RampFiatCurrency = (typeof RAMP_FIAT_CURRENCIES)[number];

export const ONRAMP_SOURCE_CURRENCIES = ${renderStringArray(onrampSourceCurrencies)} as const satisfies readonly RampFiatCurrency[];
export type OnrampSourceCurrency = (typeof ONRAMP_SOURCE_CURRENCIES)[number];

export const OFFRAMP_DESTINATION_CURRENCIES = ${renderStringArray(offrampDestinationCurrencies)} as const satisfies readonly RampFiatCurrency[];
export type OfframpDestinationCurrency = (typeof OFFRAMP_DESTINATION_CURRENCIES)[number];

export const ONRAMP_SUPPORT = [
${renderRows(input.onrampRows)}
] as const satisfies readonly OnrampPairSupport<RampFiatCurrency>[];

export const OFFRAMP_SUPPORT = [
${renderRows(input.offrampRows)}
] as const satisfies readonly OfframpPairSupport<RampFiatCurrency>[];
`;
}

async function emitRampSupport(): Promise<void> {
  console.log("\n[emit] building ramp support matrices from .ramp-rails/ dumps");

  const support = await rampClient.readRailSupport(readDump);
  for (const provider of RAMP_PROVIDERS) {
    const s = support[provider];
    console.log(
      `  [${provider}] onramp=${s.onrampFiats.size} fiats x ${s.onrampCryptos.size} cryptos; offramp=${s.offrampCryptos.size} cryptos x ${s.offrampFiats.size} fiats`
    );
  }

  const onrampRows = buildOnrampMatrix(support);
  const offrampRows = buildOfframpMatrix(support);
  const providerSnapshots = buildProviderSupportSnapshots(support);
  const rendered = renderGeneratedFile({ onrampRows, offrampRows, providerSnapshots });

  await mkdir(path.dirname(EMIT_TARGET), { recursive: true });
  await writeFile(EMIT_TARGET, rendered, "utf8");
  console.log(
    `\n  ✔ wrote ${onrampRows.length} onramp pairs and ${offrampRows.length} offramp pairs → ${path.relative(process.cwd(), EMIT_TARGET)}`
  );
}

const SUMMARY: Record<string, { ok: number; failed: number }> = {};

async function dump(name: string, payload: RampDiscoveryResponseDump): Promise<void> {
  const file = path.join(OUTPUT_DIR, `${name}.json`);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

async function fetchJson(
  provider: RampProviderId,
  label: string,
  url: string,
  init: RequestInit = {}
): Promise<RampDiscoveryResponseDump> {
  let bucket = SUMMARY[provider];
  if (!bucket) {
    bucket = { ok: 0, failed: 0 };
    SUMMARY[provider] = bucket;
  }
  const response = await fetch(url, init);
  const text = await response.text();
  let body: unknown;
  try {
    body = text.length > 0 ? JSON.parse(text) : null;
  } catch {
    body = { _rawText: text };
  }

  if (response.ok) {
    bucket.ok += 1;
    console.log(`  ✔ ${label} (${response.status})`);
  } else {
    bucket.failed += 1;
    console.warn(`  ✗ ${label} (${response.status})`);
  }

  return { status: response.status, body };
}

function isRampProviderId(value: string): value is RampProviderId {
  return (RAMP_PROVIDERS as readonly string[]).includes(value);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const emit = args.includes("--emit");
  const strict = args.includes("--strict");
  const emitOnly = args.includes("emit");
  const targetArgs = args.filter((a) => !a.startsWith("--") && a !== "emit");
  const invalidTarget = targetArgs.find((target) => !isRampProviderId(target));
  if (invalidTarget) {
    throw new Error(`Unknown ramp rail provider: ${invalidTarget}`);
  }
  const selectedProviders = targetArgs.length
    ? (targetArgs as RampProviderId[])
    : [...RAMP_PROVIDERS];

  if (!emitOnly) {
    await mkdir(OUTPUT_DIR, { recursive: true });
    console.log(`Output dir: ${path.relative(process.cwd(), OUTPUT_DIR)}`);

    const failures: string[] = [];
    for (const provider of selectedProviders) {
      console.log(`\n[${provider}]`);
      try {
        await rampClient._discoverProviderRails(provider, {
          env: process.env,
          fetchJson,
          writeDump: dump,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        failures.push(`${provider}: ${message}`);
        console.error(`${provider} run failed:`, message);
      }
    }

    console.log("\nSummary:");
    for (const [provider, stats] of Object.entries(SUMMARY)) {
      console.log(`  ${provider}: ${stats.ok} ok, ${stats.failed} failed`);
    }
    console.log(`Responses written to ${path.relative(process.cwd(), OUTPUT_DIR)}/`);

    if (strict && failures.length > 0) {
      throw new Error(`Ramp rail discovery failed:\n${failures.join("\n")}`);
    }
  }

  if (emit || emitOnly) {
    await emitRampSupport();
  }
}

void main();
