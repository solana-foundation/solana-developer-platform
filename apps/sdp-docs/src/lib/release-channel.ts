import type {
  OperationFamily,
  OperationType,
  RampProviderId,
  SdpModule,
  SdpReleaseChannel,
} from "@sdp/types";
import { parse as parseYaml } from "yaml";
import generatedSurface from "../generated/public-surface.json";

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

/** A plain object, such as parsed frontmatter or a page's data. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/;

/** A raw MDX page's frontmatter block, or undefined. */
export function frontmatterOf(source: string): { raw: string; data: Record<string, unknown> } {
  const raw = source.match(FRONTMATTER)?.[0] ?? "";
  const body = source.match(FRONTMATTER)?.[1];
  if (body === undefined) return { raw, data: {} };
  const data: unknown = parseYaml(body);
  // Empty frontmatter parses to null; anything else must be a mapping.
  if (data === null) return { raw, data: {} };
  if (!isRecord(data)) throw new Error("Frontmatter must be a YAML mapping");
  return { raw, data };
}

/**
 * A page's gate from its frontmatter: `module: <module>` for a page about one
 * module, `rampProvider: <provider>` for a page about one ramp provider (which
 * implies Ramps). Undefined for a page every channel publishes.
 */
export function pageGateOf(
  data: { module?: unknown; rampProvider?: unknown },
  where: string
): ChannelGate | undefined {
  if (data.module !== undefined && data.rampProvider !== undefined) {
    throw new Error(`${where}: a page takes module or rampProvider, not both`);
  }
  for (const key of ["module", "rampProvider"] as const) {
    const value = data[key];
    if (value === undefined || value === null) continue;
    if (typeof value !== "string") throw new Error(`${where}: ${key} must be a string`);
    return parseGate(key, value, where);
  }
  return undefined;
}

/** Whether the build publishes a page with this frontmatter. */
export function isPagePublished(
  data: { module?: unknown; rampProvider?: unknown },
  where: string,
  surface = publicSurface
): boolean {
  const gate = pageGateOf(data, where);
  return gate === undefined || isGatePublished(gate, surface);
}

/** Whether a raw MDX page is published by this build. */
export function isPageSourcePublished(source: string, where: string): boolean {
  return isPagePublished(frontmatterOf(source).data, where);
}
