import { docs } from "../../.source";
import { loader } from "fumadocs-core/source";

const mdxSource = docs.toFumadocsSource();
const normalizedFiles =
  typeof mdxSource.files === "function" ? mdxSource.files() : mdxSource.files;

export const source = loader({
  baseUrl: "/docs",
  source: {
    ...mdxSource,
    files: normalizedFiles,
  },
});
