import type { OperationFamily, OperationType } from "@sdp/types/allowed-operations";
import type { RampProviderId } from "@sdp/types/provider-access";
import type { SdpModule, SdpReleaseChannel } from "@sdp/types/release-channels";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import generatedSurface from "@/generated/public-surface.json";

/**
 * What this docs build may publish: the modules and ramp providers of the
 * deployment's release channel, Earn's publication hold included. The API
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
  allowedOperations: readonly { family: OperationFamily; types: readonly OperationType[] }[];
  allModules: readonly SdpModule[];
  allRampProviders: readonly RampProviderId[];
};

// SAFETY: createPublicSurfaceManifest (apps/sdp-api/src/openapi/spec.ts) writes
// this file from the same types, and CI diffs it against a fresh generation;
// JSON imports widen its unions to string.
export const publicSurface = generatedSurface as PublicSurface;

/** What a page or list entry is about: one module, or one ramp provider. */
export type ChannelGate = { module: SdpModule } | { rampProvider: RampProviderId };

/**
 * Parses a module or ramp provider named in content (frontmatter), so a typo
 * fails the build instead of publishing or hiding a page.
 *
 * @throws When the name is not a known module or ramp provider.
 */
export function parseGate(
  key: "module" | "rampProvider",
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
  const rampProvider = surface.allRampProviders.find((candidate) => candidate === value);
  if (rampProvider) return { rampProvider };
  throw new Error(
    `${where}: rampProvider must be one of ${surface.allRampProviders.join(", ")}; got "${value}"`
  );
}

/** Whether the build publishes content behind `gate`. */
export function isGatePublished(gate: ChannelGate, surface = publicSurface): boolean {
  return "module" in gate
    ? surface.modules.includes(gate.module)
    : surface.rampProviders.includes(gate.rampProvider);
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
  .looseObject({ module: z.string().optional(), rampProvider: z.string().optional() })
  .refine(
    (fields) => fields.module === undefined || fields.rampProvider === undefined,
    "a page takes module or rampProvider, not both"
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
 * implies Ramps). Undefined for a page every channel publishes.
 */
export function pageGateOf(data: PageGateFields, where: string): ChannelGate | undefined {
  if (data.module !== undefined) return parseGate("module", data.module, where);
  if (data.rampProvider !== undefined) return parseGate("rampProvider", data.rampProvider, where);
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
export function isPageSourcePublished(source: string, where: string): boolean {
  return isPagePublished(frontmatterOf(source, where).data, where);
}
