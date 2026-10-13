const FENCE = /^\s*(`{3,}|~{3,})/;

/**
 * Turns an MDX page into its markdown body: drops the frontmatter and the
 * page's own `import` lines. An `import` inside a fenced code block belongs to
 * the code sample, so fenced lines are kept as written. Shared by the
 * `/docs/*.md` route and the llms.txt generator so both read pages the same way.
 */
export function stripMdxShell(source: string): string {
  const body = source.replace(/^---\n[\s\S]*?\n---\n?/, "");
  let openFence: string | null = null;
  const kept: string[] = [];

  for (const line of body.split("\n")) {
    const fence = FENCE.exec(line)?.[1];
    if (fence) {
      if (openFence === null) {
        openFence = fence;
      } else if (fence[0] === openFence[0] && fence.length >= openFence.length) {
        openFence = null;
      }
    } else if (openFence === null && /^import\s/.test(line)) {
      continue;
    }
    kept.push(line);
  }

  return kept
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
