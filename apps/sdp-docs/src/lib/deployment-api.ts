import { aiSkillUrl, apiUrl, canonicalSite, docsUrl } from "./site";

/** A fence line: optional indent (a fence can sit in a list item), then three or more ` or ~. */
const FENCE = /^\s*(`{3,}|~{3,})/;

/**
 * Markdown pointed at this deployment's API (`apiUrl`, from `NEXT_PUBLIC_SDP_API_URL`), as its
 * page shows it: in fenced code, in links and in bare URLs. Inline code keeps the host its author
 * wrote. Pages and committed files write the canonical host; the Markdown and llms routes serve
 * this.
 *
 * @param markdown - Markdown that names the canonical API.
 * @returns The same Markdown, calling this deployment's API.
 */
export function pointAtApi(markdown: string): string {
  if (apiUrl === canonicalSite.apiUrl) return markdown;
  const atDeployment = (text: string) => text.replaceAll(canonicalSite.apiUrl, apiUrl);
  let fence: string | undefined;
  return markdown
    .split("\n")
    .map((line) => {
      const marker = FENCE.exec(line)?.[1];
      if (fence === undefined) {
        if (marker !== undefined) {
          fence = marker;
          return line;
        }
        // Outside a fence, every second backtick-delimited part is an inline code span.
        return line
          .split("`")
          .map((part, index) => (index % 2 === 0 ? atDeployment(part) : part))
          .join("`");
      }
      // A fence closes on the same character, at least as long, with nothing after it.
      if (marker?.startsWith(fence) && line.trim() === marker) {
        fence = undefined;
        return line;
      }
      return atDeployment(line);
    })
    .join("\n");
}

/**
 * A generated llms file as this deployment serves it. The committed file names the canonical docs
 * and API, so no build's URLs leak into the repo; a deployment describes its own.
 *
 * @param text - The generated `llms.txt` or `llms-full.txt`.
 * @returns The file with this deployment's docs, skill and API URLs.
 */
export function llmsForDeployment(text: string): string {
  return pointAtApi(text)
    .replaceAll(canonicalSite.aiSkillUrl, aiSkillUrl)
    .replaceAll(canonicalSite.docsUrl, docsUrl);
}
