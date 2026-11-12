import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { remarkHeading, remarkStructure, type StructuredData } from "fumadocs-core/mdx-plugins";
import remarkMdx from "remark-mdx";
import remarkParse from "remark-parse";
import { unified } from "unified";
import { remarkDocsBlocks } from "@/lib/docs-blocks";
import { type PublicSurface, publicSurface } from "@/lib/release-channel";

function searchData(module: string | undefined, surface: PublicSurface): StructuredData {
  const frontmatter = module === undefined ? "" : `---\nmodule: ${module}\n---\n\n`;
  const source = `${frontmatter}## Sign with your wallet\n\n<Tab value="TypeScript">\n\n\`\`\`typescript\nconst unsigned = getTransactionDecoder().decode(bytes);\n\`\`\`\n\n</Tab>`;
  const processor = unified()
    .use(remarkParse)
    .use(remarkMdx)
    .use(remarkDocsBlocks, { surface })
    .use(remarkHeading)
    .use(remarkStructure);
  const file = { value: source, data: {} as { structuredData?: StructuredData } };
  processor.runSync(processor.parse(source), file);
  assert.ok(file.data.structuredData);
  return file.data.structuredData;
}

describe("Earn code search", () => {
  it("indexes a code-only identifier with the enclosing stage anchor", () => {
    const surface: PublicSurface = {
      ...publicSurface,
      modules: [...publicSurface.modules, "earn"],
    };
    const data = searchData("earn", surface);
    assert.deepEqual(
      data.contents.find(({ content }) => content.includes("getTransactionDecoder")),
      {
        content: "const unsigned = getTransactionDecoder().decode(bytes);",
        heading: "sign-with-your-wallet",
      }
    );
  });

  it("does not index channel-excluded Earn snippets or broaden other modules' code search", () => {
    const excluded: PublicSurface = {
      ...publicSurface,
      modules: publicSurface.modules.filter((module) => module !== "earn"),
    };
    for (const module of ["earn", undefined]) {
      const data = searchData(module, excluded);
      assert.equal(
        data.contents.some(({ content }) => content.includes("getTransactionDecoder")),
        false
      );
    }
  });
});
