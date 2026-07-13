import path from "node:path";
import type { Plugin } from "vite";

const API_SOURCE_ROOT = path.resolve(__dirname, "../../apps/sdp-api/src");

/** Resolve aliases used internally by the API implementation behind the facade. */
export function resolveApiInternalImports(): Plugin {
  return {
    name: "sdp-api-internal-imports",
    enforce: "pre",
    async resolveId(source, importer) {
      if (!source.startsWith("@/")) {
        return undefined;
      }

      const resolved = await this.resolve(
        path.resolve(API_SOURCE_ROOT, source.slice(2)),
        importer,
        { skipSelf: true }
      );
      return resolved?.id;
    },
  };
}
