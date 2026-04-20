import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const sourceFileCandidates = [
  path.resolve(__dirname, "../.source/server.ts"),
  path.resolve(__dirname, "../.source/index.ts"),
];
const sourceConfigShimPath = path.resolve(__dirname, "../.source/source.config.mjs");
const sourceConfigShim = `import { defineDocs } from "fumadocs-mdx/config";

export const docs = defineDocs({
  dir: "content/docs",
});

export default docs;
`;

const run = async () => {
  let content;
  let sourceFilePath;

  for (const candidate of sourceFileCandidates) {
    try {
      content = await fs.readFile(candidate, "utf8");
      sourceFilePath = candidate;
      break;
    } catch (error) {
      if (error.code !== "ENOENT") {
        throw error;
      }
    }
  }

  if (!content || !sourceFilePath) {
    throw new Error("Missing Fumadocs source output. Run fumadocs-mdx before patching.");
  }

  let replaced = content.replace(/_runtime\.docs<[^>]+>\(/g, "_runtime.docs(");
  const exportAliases = [];
  const defaultExports = [
    {
      pattern: /export const default =/g,
      localName: "_default",
      exportName: "default",
    },
    {
      pattern: /export const defaultCollection =/g,
      localName: "_defaultCollection",
      // biome-ignore lint/security/noSecrets: Generated Fumadocs export identifier, not a secret.
      exportName: "defaultCollection",
    },
  ];

  for (const { pattern, localName, exportName } of defaultExports) {
    if (!pattern.test(replaced)) {
      continue;
    }

    pattern.lastIndex = 0;
    replaced = replaced.replace(pattern, `const ${localName} =`);
    exportAliases.push(`${localName} as ${exportName}`);
  }

  const exportStatement = exportAliases.length > 0 ? `export { ${exportAliases.join(", ")} };` : "";
  const patched =
    exportStatement && !replaced.includes(exportStatement)
      ? `${replaced}\n${exportStatement}\n`
      : replaced;

  if (patched !== content) {
    await fs.writeFile(sourceFilePath, patched, "utf8");
    console.log(
      `Patched ${path.relative(path.resolve(__dirname, ".."), sourceFilePath)} for Next.js parser compatibility`
    );
  } else {
    console.log("No Fumadocs source patch required");
  }

  await fs.writeFile(sourceConfigShimPath, sourceConfigShim, "utf8");
};

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
