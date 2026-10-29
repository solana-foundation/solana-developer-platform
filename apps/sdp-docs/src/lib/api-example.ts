import type { SnippetLanguage } from "@sdp/api-catalog/snippets";
import type { SdpReleaseChannel } from "@sdp/types/release-channels";
import type { RootContent } from "mdast";
import { z } from "zod";

// source.config.ts loads this without a workspace runtime resolver, as with API_METHOD_NAMES.
const LANGUAGES = ["curl", "ts", "py"] as const satisfies readonly SnippetLanguage[];

const exampleSchema = z.strictObject({
  operation: z.string().min(1),
  language: z.enum(LANGUAGES).default("curl"),
});

/** One guide example, named by the public reference's endpoint ID. */
export type ApiExampleDirective = z.infer<typeof exampleSchema>;

/** The snippets generated for one published operation. */
export type GuideApiExample = {
  snippets: Record<SnippetLanguage, string>;
};

/** A release channel's guide examples, generated from its public API reference. */
export type GuideApiExamples = {
  releaseChannel: SdpReleaseChannel;
  operations: Record<string, GuideApiExample>;
};

/** Parse `<ApiExample operation="..." />` without accepting arbitrary MDX expressions. */
export function apiExampleOf(node: RootContent, where: string): ApiExampleDirective | undefined {
  if (node.type !== "mdxJsxFlowElement" && node.type !== "mdxJsxTextElement") return undefined;
  if (node.name !== "ApiExample") return undefined;
  if (node.type !== "mdxJsxFlowElement" || node.children.length > 0) {
    throw new Error(`${where}: <ApiExample /> must stand on its own line`);
  }
  const attributes: Record<string, string> = {};
  for (const attribute of node.attributes) {
    if (attribute.type !== "mdxJsxAttribute" || typeof attribute.value !== "string") {
      throw new Error(`${where}: <ApiExample /> takes string attributes only`);
    }
    attributes[attribute.name] = attribute.value;
  }
  const parsed = exampleSchema.safeParse(attributes);
  if (!parsed.success) {
    throw new Error(`${where}: invalid <ApiExample />: ${z.prettifyError(parsed.error)}`);
  }
  return parsed.data;
}

/** A generated request as a plain fence, usable by the HTML and Markdown pipelines. */
export function renderApiExample(
  directive: ApiExampleDirective,
  catalog: GuideApiExamples,
  releaseChannel: SdpReleaseChannel,
  where: string,
  pagePublished: boolean
): string {
  // Fumadocs compiles gated pages before the source loader removes them.
  if (!pagePublished) return "";
  if (catalog.releaseChannel !== releaseChannel) {
    throw new Error(
      `${where}: guide examples are for ${catalog.releaseChannel}, not ${releaseChannel}`
    );
  }
  const example = catalog.operations[directive.operation];
  if (example === undefined) {
    throw new Error(`${where}: ${directive.operation} is not in this channel's public API`);
  }
  const language = { curl: "bash", ts: "typescript", py: "python" }[directive.language];
  const body = example.snippets[directive.language];
  const longestRun = Math.max(0, ...(body.match(/`{3,}/g) ?? []).map((run) => run.length));
  const fence = "`".repeat(Math.max(3, longestRun + 1));
  return `${fence}${language}\n${body}\n${fence}`;
}
