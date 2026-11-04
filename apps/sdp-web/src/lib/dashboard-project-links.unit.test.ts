import { existsSync, readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SRC = fileURLToPath(new URL("..", import.meta.url));

/** Where a page inside a Project renders its links, and where its server code redirects. */
const SCANNED_ROOTS = ["app/(session)/dashboard", "components"];

/**
 * A dashboard sub-path written as a link or redirect target leaves the Project out: the router
 * sends it through `/dashboard?return_to=` and the shell unmounts on the way. Bare `/dashboard`
 * is the one unscoped target, the way to choose a Project (no active Organization, a left one).
 */
const UNSCOPED_TARGET =
  /(?:href=\{?\s*|\b(?:push|replace|redirect|prefetch)\(\s*)["'`]\/dashboard\/[^"'`]*/g;

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true, recursive: true })
    .filter((entry) => entry.isFile() && /\.tsx?$/.test(entry.name))
    .filter((entry) => !/\.(unit\.)?test\.tsx?$/.test(entry.name))
    .map((entry) => `${entry.parentPath}/${entry.name}`);
}

describe("dashboard links", () => {
  it("name their Project wherever a page writes one", () => {
    expect(SCANNED_ROOTS.filter((root) => !existsSync(`${SRC}${root}`))).toEqual([]);

    const unscoped = SCANNED_ROOTS.flatMap((root) => sourceFiles(`${SRC}${root}`)).flatMap((file) =>
      [...readFileSync(file, "utf8").matchAll(UNSCOPED_TARGET)].map(
        ([target]) => `${file.slice(SRC.length)}: ${target}`
      )
    );

    // useProjectHref() in a client component, requestProjectHref() in server code.
    expect(unscoped).toEqual([]);
  });
});
