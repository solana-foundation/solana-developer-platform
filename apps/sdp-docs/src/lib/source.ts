import { loader, type VirtualFile } from "fumadocs-core/source";
import { icons } from "lucide-react";
import { createElement } from "react";
import { docs } from "../../.source/server";

type FumadocsSource = {
  files: VirtualFile[] | (() => VirtualFile[]);
} & Record<string, unknown>;

const mdxSource = (
  docs as unknown as { toFumadocsSource: () => FumadocsSource }
).toFumadocsSource();
const normalizedFiles = typeof mdxSource.files === "function" ? mdxSource.files() : mdxSource.files;

export const source = loader({
  baseUrl: "/docs",
  icon(icon) {
    if (!icon) return undefined;
    if (!(icon in icons)) {
      throw new Error(`Unknown sidebar icon "${icon}" — use a lucide-react icon name.`);
    }
    return createElement(icons[icon as keyof typeof icons]);
  },
  source: {
    ...mdxSource,
    files: normalizedFiles,
  },
});
