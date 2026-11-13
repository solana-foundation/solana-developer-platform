import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { describe, it } from "node:test";
import { SDP_GITHUB_REPO_URL } from "@sdp/types/site";
import { z } from "zod";

// Each Earn quickstart has a folder under examples/ that holds its code as files to clone and
// run. The folders have no tests of their own: earn-guide-examples.test.ts runs the pages' code,
// and this file holds each folder to its page, so a change to one that skips the other fails here.
type Example = {
  /** The page under content/docs/earn, without its extension. */
  page: string;
  /** The folder under examples/. */
  folder: string;
  /** The page's TypeScript file: its blocks of that title, top to bottom. */
  script: string;
  /** What follows the API host in the script's `api` constant. */
  apiPath: string;
  /** A file the page's cURL path shows whole. */
  helper?: string;
};
const EXAMPLES: Example[] = [
  {
    page: "quickstart",
    folder: "embedded-yield-quickstart",
    script: "deposit.ts",
    apiPath: "/v1/earn",
    helper: "sign.mjs",
  },
  {
    page: "treasury-quickstart",
    folder: "treasury-quickstart",
    script: "deposit.mts",
    apiPath: "/v1",
  },
];

// The one place an example differs from its page. A page shows its deployment's API in place of
// the canonical host; a file on GitHub cannot, so it names the hosted sandbox and reads
// SDP_API_URL.
const CANONICAL_API = "https://api.solana.com";
const SANDBOX_API = "https://api-beta.solana.com";
const pageApiLine = (apiPath: string) => `const api = "${CANONICAL_API}${apiPath}";`;
const exampleApiLine = (apiPath: string) =>
  `const api = \`\${process.env.SDP_API_URL ?? "${SANDBOX_API}"}${apiPath}\`;`;

const manifestSchema = z.object({ dependencies: z.record(z.string(), z.string()).optional() });

/** The page's code blocks titled `title` or `title (continued)`, in page order. */
function blocks(source: string, language: string, title: string): string[] {
  const fences = new RegExp(`\`\`\`${language} title="([^"]+)"\\n([\\s\\S]*?)\`\`\``, "g");
  return [...source.matchAll(fences)]
    .filter((match) => match[1] === title || match[1] === `${title} (continued)`)
    .map((match) => match[2] ?? "");
}

/** Every command line of the page's cURL tabs, in page order, without comments. */
function curlLines(source: string): string[] {
  const tabs = /<Tab value="cURL">\n\n```bash title="Terminal"\n([\s\S]*?)```\n\n<\/Tab>/g;
  return [...source.matchAll(tabs)]
    .flatMap((match) => (match[1] ?? "").split("\n"))
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith("#"));
}

/** A page cURL line as deposit.sh writes it: the API is `$SDP_API_URL`, and its URL is quoted. */
function scripted(line: string): string {
  return line
    .replace(/(?<!")https:\/\/api\.solana\.com(\S*)/, (_url, route) => `"$SDP_API_URL${route}"`)
    .replace(CANONICAL_API, () => "$SDP_API_URL");
}

for (const { page, folder, script, apiPath, helper } of EXAMPLES) {
  const pageFile = new URL(`../content/docs/earn/${page}.mdx`, import.meta.url);
  const example = new URL(`../../../examples/${folder}/`, import.meta.url);
  const link = `${SDP_GITHUB_REPO_URL}/tree/main/examples/${folder}`;
  const readPage = () => fs.readFile(pageFile, "utf8");
  const readExample = (file: string) => fs.readFile(new URL(file, example), "utf8");

  describe(`examples/${folder}`, () => {
    it(`${script} is the page's ${script}, pointed at the sandbox API`, async () => {
      const authored = blocks(await readPage(), "typescript", script).join("\n");
      const pageApi = pageApiLine(apiPath);
      assert.equal(authored.split(pageApi).length, 2, "the page sets its API host once");
      assert.equal(
        await readExample(script),
        authored.replace(pageApi, () => exampleApiLine(apiPath))
      );
    });

    if (helper) {
      it(`${helper} is the page's ${helper}`, async () => {
        const authored = blocks(await readPage(), "javascript", helper);
        assert.equal(authored.length, 1);
        assert.equal(await readExample(helper), authored[0]);
      });
    }

    it("deposit.sh runs the page's cURL commands in order, against SDP_API_URL", async () => {
      const commands = curlLines(await readPage());
      const shell = (await readExample("deposit.sh")).split("\n");
      assert.ok(commands.length > 0);
      let next = 0;
      for (const command of commands.map(scripted)) {
        const at = shell.findIndex((line, index) => index >= next && line.includes(command));
        assert.notEqual(at, -1, `deposit.sh lacks this line, or has it out of order: ${command}`);
        next = at + 1;
      }
      // The script adds checks and a poll loop around the page's requests, and no request of its
      // own.
      const requests = (lines: string[]) =>
        lines.filter((line) => line.includes("curl -sS")).length;
      assert.equal(requests(shell), requests(commands));
    });

    it("depends on the @solana/kit major its page installs, or on no package", async () => {
      const install = /npm install @solana\/kit@(\d+)/.exec(await readPage());
      const manifest = manifestSchema.parse(JSON.parse(await readExample("package.json")));
      assert.equal(manifest.dependencies?.["@solana/kit"]?.split(".")[0], install?.[1]);
    });

    it("is linked from its page, and the folder the link names exists", async () => {
      assert.ok((await readPage()).includes(`](${link})`), `no link to ${link}`);
      // check:links probes external URLs, and this one answers 404 until the folder is on main,
      // so link-check.config.json skips it and this checks the folder instead.
      await fs.access(new URL("README.md", example));
    });
  });
}
