import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

import type { CryptoRailId, FiatCurrencyCode } from "@sdp/types/payment-rails";
import { RAMP_PROVIDERS, type RampProviderId } from "@sdp/types/provider-access";

const execFileAsync = promisify(execFile);

const GENERATED_RELATIVE_PATH = "packages/sdp-types/src/generated/ramp-support.generated.ts";
const GENERATED_PATH = path.resolve(process.cwd(), "../../", GENERATED_RELATIVE_PATH);
const MAX_LISTED_CHANGES = 20;

interface GeneratedOnrampRow {
  source: FiatCurrencyCode;
  dest: CryptoRailId;
  providers: readonly RampProviderId[];
}

interface GeneratedOfframpRow {
  source: CryptoRailId;
  dest: FiatCurrencyCode;
  providers: readonly RampProviderId[];
}

interface GeneratedRampSupportModule {
  RAMP_SUPPORT_HASH?: string;
  RAMP_PROVIDER_SUPPORT_HASHES?: Partial<Record<RampProviderId, string>>;
  ONRAMP_SUPPORT: readonly GeneratedOnrampRow[];
  OFFRAMP_SUPPORT: readonly GeneratedOfframpRow[];
}

interface ProviderPairs {
  onramp: string[];
  offramp: string[];
}

interface ProviderDiff {
  provider: RampProviderId;
  baseHash: string;
  currentHash: string;
  base: ProviderPairs;
  current: ProviderPairs;
  addedOnramp: string[];
  removedOnramp: string[];
  addedOfframp: string[];
  removedOfframp: string[];
}

function sha256Json(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function shortHash(hash: string | undefined): string {
  return hash ? hash.slice(0, 12) : "—";
}

function diffArrays(
  base: readonly string[],
  current: readonly string[]
): {
  added: string[];
  removed: string[];
} {
  const baseSet = new Set(base);
  const currentSet = new Set(current);
  return {
    added: current.filter((value) => !baseSet.has(value)),
    removed: base.filter((value) => !currentSet.has(value)),
  };
}

function pairsByProvider(
  module: GeneratedRampSupportModule
): Record<RampProviderId, ProviderPairs> {
  const byProvider = Object.fromEntries(
    RAMP_PROVIDERS.map((provider) => [provider, { onramp: [], offramp: [] }])
  ) as Record<RampProviderId, ProviderPairs>;

  for (const row of module.ONRAMP_SUPPORT) {
    for (const provider of row.providers) {
      byProvider[provider].onramp.push(`${row.source} -> ${row.dest}`);
    }
  }

  for (const row of module.OFFRAMP_SUPPORT) {
    for (const provider of row.providers) {
      byProvider[provider].offramp.push(`${row.source} -> ${row.dest}`);
    }
  }

  for (const provider of RAMP_PROVIDERS) {
    byProvider[provider].onramp.sort();
    byProvider[provider].offramp.sort();
  }

  return byProvider;
}

function providerHash(module: GeneratedRampSupportModule, provider: RampProviderId): string {
  const explicitHash = module.RAMP_PROVIDER_SUPPORT_HASHES?.[provider];
  if (explicitHash) return explicitHash;
  return sha256Json(pairsByProvider(module)[provider]);
}

async function importGeneratedModule(filePath: string): Promise<GeneratedRampSupportModule> {
  const fileUrl = pathToFileURL(filePath);
  return (await import(
    `${fileUrl.href}?t=${Date.now()}-${Math.random()}`
  )) as GeneratedRampSupportModule;
}

async function readBaseGeneratedSource(): Promise<string> {
  const baseRef = process.env.RAMP_RAILS_BASE_REF?.trim() || "HEAD";
  try {
    const { stdout } = await execFileAsync("git", [
      "show",
      `${baseRef}:${GENERATED_RELATIVE_PATH}`,
    ]);
    return stdout;
  } catch {
    // Local smoke tests before the generated file is committed should still run.
    return readFile(GENERATED_PATH, "utf8");
  }
}

function summarizeList(title: string, values: readonly string[]): void {
  if (values.length === 0) return;
  console.log(`  ${title}:`);
  for (const value of values.slice(0, MAX_LISTED_CHANGES)) {
    console.log(`    - ${value}`);
  }
  if (values.length > MAX_LISTED_CHANGES) {
    console.log(`    - ...and ${values.length - MAX_LISTED_CHANGES} more`);
  }
}

async function main(): Promise<void> {
  const failOnDrift = process.argv.slice(2).includes("--fail-on-drift");
  const generatedDir = path.dirname(GENERATED_PATH);
  const baseTempPath = path.join(generatedDir, `.ramp-support.base-${process.pid}.generated.ts`);
  const baseSource = await readBaseGeneratedSource();
  await writeFile(baseTempPath, baseSource, "utf8");

  try {
    const [baseModule, currentModule] = await Promise.all([
      importGeneratedModule(baseTempPath),
      importGeneratedModule(GENERATED_PATH),
    ]);
    const basePairs = pairsByProvider(baseModule);
    const currentPairs = pairsByProvider(currentModule);
    const diffs: ProviderDiff[] = [];

    for (const provider of RAMP_PROVIDERS) {
      const baseHash = providerHash(baseModule, provider);
      const currentHash = providerHash(currentModule, provider);
      if (baseHash === currentHash) continue;

      const onrampDiff = diffArrays(basePairs[provider].onramp, currentPairs[provider].onramp);
      const offrampDiff = diffArrays(basePairs[provider].offramp, currentPairs[provider].offramp);
      diffs.push({
        provider,
        baseHash,
        currentHash,
        base: basePairs[provider],
        current: currentPairs[provider],
        addedOnramp: onrampDiff.added,
        removedOnramp: onrampDiff.removed,
        addedOfframp: offrampDiff.added,
        removedOfframp: offrampDiff.removed,
      });
    }

    if (diffs.length > 0) {
      console.log(`Ramp rails drift detected for ${diffs.length} provider(s).`);
      if (baseModule.RAMP_SUPPORT_HASH !== currentModule.RAMP_SUPPORT_HASH) {
        console.log(
          `  RAMP_SUPPORT_HASH ${shortHash(baseModule.RAMP_SUPPORT_HASH)} -> ${shortHash(currentModule.RAMP_SUPPORT_HASH)}`
        );
      }
      for (const diff of diffs) {
        console.log(
          `\n[${diff.provider}] hash ${shortHash(diff.baseHash)} -> ${shortHash(diff.currentHash)}; onramp ${diff.base.onramp.length} -> ${diff.current.onramp.length} (+${diff.addedOnramp.length}/-${diff.removedOnramp.length}), offramp ${diff.base.offramp.length} -> ${diff.current.offramp.length} (+${diff.addedOfframp.length}/-${diff.removedOfframp.length})`
        );
        summarizeList("Added on-ramp rails", diff.addedOnramp);
        summarizeList("Removed on-ramp rails", diff.removedOnramp);
        summarizeList("Added off-ramp rails", diff.addedOfframp);
        summarizeList("Removed off-ramp rails", diff.removedOfframp);
      }
      if (failOnDrift) {
        console.error(
          "\nThe committed ramp support matrix is out of sync with the provider rail code/dumps.\n" +
            "Regenerate it from the committed dumps and commit the result:\n" +
            "  pnpm --filter @sdp/api rails:generate\n" +
            "  git add packages/sdp-types/src/generated/ramp-support.generated.ts\n"
        );
        process.exitCode = 1;
      }
    } else {
      console.log("No ramp rails drift detected.");
    }
  } finally {
    await unlink(baseTempPath).catch(() => undefined);
  }
}

void main();
