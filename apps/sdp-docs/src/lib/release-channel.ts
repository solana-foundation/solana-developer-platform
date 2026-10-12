import {
  isModuleInReleaseChannel,
  resolveSdpReleaseChannel,
  SDP_MODULES,
  SDP_RAMP_PROVIDER_STAGES,
  type SdpModule,
  type SdpReleaseChannel,
} from "@sdp/types";

/**
 * The docs deployment's release channel. Each deployment documents only the
 * modules its API runs, so production (`stable`) never documents a route it
 * refuses with 403.
 *
 * A Vercel build must set `SDP_RELEASE_CHANNEL` (a missing value fails the
 * build, like sdp-web). Elsewhere (local runs, CI drift checks, the Dockerfile's
 * default) an unset value means `experimental`, which documents every module
 * and is what the committed generated artifacts hold.
 *
 * @param env - The process environment.
 * @returns The release channel to build the docs for.
 */
export function docsReleaseChannel(
  env: Record<string, string | undefined> = process.env
): SdpReleaseChannel {
  if (env.VERCEL) {
    return resolveSdpReleaseChannel(env.SDP_RELEASE_CHANNEL);
  }
  return resolveSdpReleaseChannel(env.SDP_RELEASE_CHANNEL || "experimental");
}

/**
 * Parses a docs `module` tag (page frontmatter or `<InChannel module>`).
 *
 * @param value - The tag's value; undefined means the content belongs to no module.
 * @param where - Where the tag sits, for the error message.
 * @throws When the value is not an SDP module, so a typo cannot publish a page.
 */
export function parseDocsModule(value: unknown, where: string): SdpModule | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "string" && (SDP_MODULES as readonly string[]).includes(value)) {
    return value as SdpModule;
  }
  throw new Error(
    `${where}: module must be one of ${SDP_MODULES.join(", ")}; got ${JSON.stringify(value)}`
  );
}

/** Whether content tagged with `module` (or untagged) is published on `releaseChannel`. */
export function isDocsModuleInChannel(
  module: SdpModule | undefined,
  releaseChannel: SdpReleaseChannel
): boolean {
  return (
    module === undefined ||
    isModuleInReleaseChannel(releaseChannel, module, SDP_RAMP_PROVIDER_STAGES)
  );
}

const FRONTMATTER = /^---\n([\s\S]*?)\n---/;

/** The `module` frontmatter tag of a raw MDX page. */
export function pageModuleOf(source: string, where: string): SdpModule | undefined {
  const frontmatter = source.match(FRONTMATTER)?.[1] ?? "";
  const value = frontmatter.match(/^module:\s*["']?([^"'\s]+)["']?\s*$/m)?.[1];
  return parseDocsModule(value, where);
}

/** Whether a raw MDX page is published on `releaseChannel`. */
export function isPageSourceInChannel(
  source: string,
  releaseChannel: SdpReleaseChannel,
  where: string
): boolean {
  return isDocsModuleInChannel(pageModuleOf(source, where), releaseChannel);
}

const IN_CHANNEL_BLOCK = /<InChannel\s+module="([^"]*)"\s*>([\s\S]*?)<\/InChannel>/g;

/**
 * Resolves `<InChannel module="…">` blocks in raw MDX the way the rendered page
 * does: a block whose module is outside the release channel is removed, any
 * other is unwrapped. For the text consumers of raw MDX (llms files, the
 * Markdown route, the link checker). Blocks do not nest. A removed block keeps
 * its line breaks, so line numbers after it still match the source file.
 */
export function resolveInChannelBlocks(
  source: string,
  releaseChannel: SdpReleaseChannel,
  where: string
): string {
  return source.replace(IN_CHANNEL_BLOCK, (block: string, module: string, body: string) =>
    isDocsModuleInChannel(parseDocsModule(module, where), releaseChannel)
      ? body
      : "\n".repeat(block.split("\n").length - 1)
  );
}
