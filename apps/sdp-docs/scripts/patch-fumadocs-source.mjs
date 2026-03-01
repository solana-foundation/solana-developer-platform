import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const sourceIndexPath = path.resolve(__dirname, "../.source/index.ts");
const sourceConfigShimPath = path.resolve(__dirname, "../.source/source.config.mjs");
const sourceConfigShim = `import { defineDocs } from "fumadocs-mdx/config";

export const docs = defineDocs({
  dir: "content/docs",
});

export default docs;
`;

const run = async () => {
  let content;

  try {
    content = await fs.readFile(sourceIndexPath, "utf8");
  } catch (error) {
    throw new Error("Missing .source/index.ts. Run fumadocs-mdx before patching.", { cause: error });
  }

  const replaced = content
    .replace(/_runtime\.docs<[^>]+>\(/g, "_runtime.docs(")
    .replace(/export const default =/g, "const _default =")
    .replace(/export const defaultCollection =/g, "const _default =");

  const patched =
    replaced.includes("const _default =") && !replaced.includes("export { _default as default };")
      ? `${replaced}\nexport { _default as default };\n`
      : replaced;

  if (patched !== content) {
    await fs.writeFile(sourceIndexPath, patched, "utf8");
    console.log("Patched .source/index.ts for Next.js parser compatibility");
  } else {
    console.log("No Fumadocs source patch required");
  }

  await fs.writeFile(sourceConfigShimPath, sourceConfigShim, "utf8");
};

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
