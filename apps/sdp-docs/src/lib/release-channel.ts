import { parse as parseYaml } from "yaml";
import generatedSurface from "../generated/public-surface.json";

/**
 * What this docs build may publish: the modules and ramp providers of the
 * deployment's release channel, Earn's publication hold included. The API
 * decides it (`createPublicSurfaceManifest` in apps/sdp-api/src/openapi/spec.ts,
 * written by `openapi:generate` from `SDP_RELEASE_CHANNEL`) and `generate:api`
 * copies it to src/generated/public-surface.json, committed at `experimental`.
 *
 * Deliberately free of workspace imports: the MDX pipeline (source.config.ts)
 * loads this file in a plain Node context.
 */
export type PublicSurface = {
  releaseChannel: string;
  modules: readonly string[];
  rampProviders: readonly string[];
  allModules: readonly string[];
  allRampProviders: readonly string[];
};

export const publicSurface: PublicSurface = generatedSurface;

/** What a page, passage or row is about: one module, or one ramp provider. */
export type ChannelGate = { module: string } | { rampProvider: string };

/**
 * Validates a gate, so a typo fails the build instead of publishing (or hiding)
 * content.
 *
 * @throws When the module or ramp provider is unknown.
 */
export function checkGate(gate: ChannelGate, where: string, surface = publicSurface): ChannelGate {
  if ("module" in gate && !surface.allModules.includes(gate.module)) {
    throw new Error(
      `${where}: module must be one of ${surface.allModules.join(", ")}; got "${gate.module}"`
    );
  }
  if ("rampProvider" in gate && !surface.allRampProviders.includes(gate.rampProvider)) {
    throw new Error(
      `${where}: rampProvider must be one of ${surface.allRampProviders.join(", ")}; got "${gate.rampProvider}"`
    );
  }
  return gate;
}

/** Whether the build publishes content behind `gate`. */
export function isGatePublished(gate: ChannelGate, surface = publicSurface): boolean {
  return "module" in gate
    ? surface.modules.includes(gate.module)
    : surface.rampProviders.includes(gate.rampProvider);
}

/** Whether the build publishes content about `module` (undefined: no module). */
export function isModulePublished(module: string | undefined, surface = publicSurface): boolean {
  return module === undefined || isGatePublished({ module }, surface);
}

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/;

/** A raw MDX page's frontmatter block, or undefined. */
export function frontmatterOf(source: string): { raw: string; data: Record<string, unknown> } {
  const raw = source.match(FRONTMATTER)?.[0] ?? "";
  const body = source.match(FRONTMATTER)?.[1];
  const data = body === undefined ? {} : ((parseYaml(body) as Record<string, unknown>) ?? {});
  return { raw, data };
}

/** The `module:` frontmatter tag of a page, validated. */
export function pageModuleOf(data: { module?: unknown }, where: string): string | undefined {
  if (data.module === undefined || data.module === null) return undefined;
  if (typeof data.module !== "string") {
    throw new Error(`${where}: module must be a string`);
  }
  checkGate({ module: data.module }, where);
  return data.module;
}

/** Whether a raw MDX page is published by this build. */
export function isPageSourcePublished(source: string, where: string): boolean {
  return isModulePublished(pageModuleOf(frontmatterOf(source).data, where));
}
