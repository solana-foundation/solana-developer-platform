import { type SourceConfig, type VirtualFile, loader } from "fumadocs-core/source";
import { docs } from "../../.source";

type FumadocsSource = {
  files: VirtualFile<SourceConfig>[] | (() => VirtualFile<SourceConfig>[]);
} & Record<string, unknown>;

const mdxSource = (docs as { toFumadocsSource: () => FumadocsSource }).toFumadocsSource();
const normalizedFiles = typeof mdxSource.files === "function" ? mdxSource.files() : mdxSource.files;

export const source = loader({
  baseUrl: "/docs",
  source: {
    ...mdxSource,
    files: normalizedFiles,
  },
});
