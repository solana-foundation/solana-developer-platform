import { loader, type VirtualFile } from "fumadocs-core/source";
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
  source: {
    ...mdxSource,
    files: normalizedFiles,
  },
});
