import type { ActionModule, ActionVerb } from "@sdp/types/actions";
import type { RateLimitTier } from "@sdp/types/api-keys";
import type {
  CustodyMode,
  CustodyProvider,
  ManagedCustodyProvider,
  WalletCreateDedupe,
} from "@sdp/types/custody";
import type { RampProviderId } from "@sdp/types/provider-access";
import type { SdpModule, SdpReleaseChannel } from "@sdp/types/release-channels";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import generatedSurface from "@/generated/public-surface.json";
import { DOCS_CUSTODY_PROVIDERS } from "./docs-catalog";

/**
 * What this docs build may publish: the modules and providers of the
 * deployment's release channel. The API
 * decides it (`createPublicSurfaceManifest` in apps/sdp-api/src/openapi/spec.ts,
 * written by `openapi:generate` from `SDP_RELEASE_CHANNEL`) and `generate:api`
 * copies it to src/generated/public-surface.json, committed at `experimental`.
 *
 * Free of runtime workspace imports (types only): the MDX pipeline
 * (source.config.ts) loads this file in a plain Node context.
 */
export type PublicSurface = {
  releaseChannel: SdpReleaseChannel;
  modules: readonly SdpModule[];
  rampProviders: readonly RampProviderId[];
  /** The custody providers the public document names, which `<CustodyProviderTable />` lists. */
  custodyProviders: readonly CustodyProvider[];
  /** The custody provider and mode pairs whose wallet create dedupes on the request id, which `<WalletCreateRetryTable />` lists. */
  walletCreateDedupe: readonly {
    provider: ManagedCustodyProvider;
    mode: CustodyMode;
    window: WalletCreateDedupe;
  }[];
  grantableActions: readonly { module: ActionModule; verbs: readonly ActionVerb[] }[];
  allModules: readonly SdpModule[];
  allRampProviders: readonly RampProviderId[];
  /** The API's rate limits, which `<RateLimitTable />` shows (apps/sdp-api/src/middleware/rate-limit.ts). */
  rateLimits: {
    windowSeconds: number;
    apiKeyTiers: Readonly<Record<RateLimitTier, number>>;
    unauthenticatedPerIp: number;
  };
};

// SAFETY: createPublicSurfaceManifest (apps/sdp-api/src/openapi/spec.ts) writes
// this file from the same types, and CI diffs it against a fresh generation;
// JSON imports widen its unions to string.
export const publicSurface = generatedSurface as PublicSurface;

/** What a page or list entry is about: one module or provider. */
export type ChannelGate =
  | { module: SdpModule }
  | { rampProvider: RampProviderId }
  | { custodyProvider: ManagedCustodyProvider };

/**
 * Parses a module or provider named in content (frontmatter), so a typo
 * fails the build instead of publishing or hiding a page.
 *
 * @throws When the name is not a known module or provider.
 */
export function parseGate(
  key: "module" | "rampProvider" | "custodyProvider",
  value: string,
  where: string,
  surface = publicSurface
): ChannelGate {
  if (key === "module") {
    const module = surface.allModules.find((candidate) => candidate === value);
    if (module) return { module };
    throw new Error(
      `${where}: module must be one of ${surface.allModules.join(", ")}; got "${value}"`
    );
  }
  if (key === "custodyProvider") {
    if (isDocsCustodyProvider(value)) return { custodyProvider: value };
    throw new Error(
      `${where}: custodyProvider must be one of ${Object.keys(DOCS_CUSTODY_PROVIDERS).join(", ")}; got "${value}"`
    );
  }
  const rampProvider = surface.allRampProviders.find((candidate) => candidate === value);
  if (rampProvider) return { rampProvider };
  throw new Error(
    `${where}: rampProvider must be one of ${surface.allRampProviders.join(", ")}; got "${value}"`
  );
}

// The catalog is exhaustive against the shared provider type. It validates names
// even when this channel's manifest excludes the provider.
function isDocsCustodyProvider(value: string): value is ManagedCustodyProvider {
  return Object.hasOwn(DOCS_CUSTODY_PROVIDERS, value);
}

/** Whether the build publishes content behind `gate`. */
export function isGatePublished(gate: ChannelGate, surface = publicSurface): boolean {
  if ("module" in gate) return surface.modules.includes(gate.module);
  if ("rampProvider" in gate) return surface.rampProviders.includes(gate.rampProvider);
  return surface.custodyProviders.includes(gate.custodyProvider);
}

/** Whether the build publishes content about `module` (undefined: no module). */
export function isModulePublished(module: SdpModule | undefined, surface = publicSurface): boolean {
  return module === undefined || isGatePublished({ module }, surface);
}

/**
 * The frontmatter fields that gate a page. Every other field passes through
 * (Fumadocs owns titles and descriptions); empty frontmatter parses to null.
 */
const pageGateFieldsSchema = z
  .looseObject({
    module: z.string().optional(),
    rampProvider: z.string().optional(),
    custodyProvider: z.string().optional(),
  })
  .refine(
    (fields) =>
      [fields.module, fields.rampProvider, fields.custodyProvider].filter(
        (value) => value !== undefined
      ).length <= 1,
    "a page takes only one of module, rampProvider or custodyProvider"
  );

export type PageGateFields = z.infer<typeof pageGateFieldsSchema>;

const frontmatterSchema = z.union([
  z.null().transform((): PageGateFields => ({})),
  pageGateFieldsSchema,
]);

/** Parses a page's frontmatter (raw YAML, or Fumadocs' page data) for its gate fields. */
export function parsePageGateFields(value: unknown, where: string): PageGateFields {
  const parsed = frontmatterSchema.safeParse(value);
  if (!parsed.success) {
    throw new Error(`${where}: invalid frontmatter: ${z.prettifyError(parsed.error)}`);
  }
  return parsed.data;
}

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/;

/** A raw MDX page's frontmatter block (empty when it has none) and its gate fields. */
export function frontmatterOf(
  source: string,
  where: string
): { raw: string; data: PageGateFields } {
  const match = source.match(FRONTMATTER);
  if (!match) return { raw: "", data: {} };
  const [raw, body] = match;
  if (body === undefined) throw new Error(`${where}: frontmatter block has no body`);
  return { raw, data: parsePageGateFields(parseYaml(body), where) };
}

/**
 * A page's gate from its frontmatter: `module: <module>` for a page about one
 * module, `rampProvider: <provider>` for a page about one ramp provider (which
 * implies Ramps), or `custodyProvider: <provider>` for a custody provider.
 * Undefined for a page every channel publishes.
 */
export function pageGateOf(data: PageGateFields, where: string): ChannelGate | undefined {
  if (data.module !== undefined) return parseGate("module", data.module, where);
  if (data.rampProvider !== undefined) return parseGate("rampProvider", data.rampProvider, where);
  if (data.custodyProvider !== undefined) {
    return parseGate("custodyProvider", data.custodyProvider, where);
  }
  return undefined;
}

/** Whether the build publishes a page with this frontmatter. */
export function isPagePublished(
  data: PageGateFields,
  where: string,
  surface = publicSurface
): boolean {
  const gate = pageGateOf(data, where);
  return gate === undefined || isGatePublished(gate, surface);
}

/** Whether a raw MDX page is published by this build. */
export function isPageSourcePublished(
  source: string,
  where: string,
  surface = publicSurface
): boolean {
  return isPagePublished(frontmatterOf(source, where).data, where, surface);
}
