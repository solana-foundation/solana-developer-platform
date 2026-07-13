import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPOSITORY_ROOT = path.resolve(SCRIPT_DIR, "..");
const MODULE_MAP_PATH = "docs/architecture/module-map.md";
const WORKSPACE_DIRECTORIES = ["apps", "packages"];
const SOURCE_EXTENSIONS = new Set([".cts", ".js", ".jsx", ".mjs", ".mts", ".ts", ".tsx"]);
const DEPENDENCY_FIELDS = [
  "dependencies",
  "devDependencies",
  "optionalDependencies",
  "peerDependencies",
];
const EXISTING_APP_REEXPORTS = [
  ["apps/sdp-api/src/db/repositories/counterparty.repository.ts", "@sdp/payments"],
  ["apps/sdp-api/src/services/adapters/index.ts", "@sdp/payments/fee-payment"],
  ["apps/sdp-api/src/services/adapters/signing/index.ts", "@sdp/custody/keychain"],
  ["apps/sdp-api/src/services/solana/index.ts", "@sdp/solana/token-2022"],
  ["apps/sdp-web/src/app/dashboard/payments/payments-workspace.data.ts", "@sdp/types"],
];

function toPosixPath(filePath) {
  return filePath.split(path.sep).join("/");
}

function listFiles(directory) {
  if (!existsSync(directory)) {
    return [];
  }

  return readdirSync(directory, { withFileTypes: true })
    .sort((left, right) => left.name.localeCompare(right.name))
    .flatMap((entry) => {
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        return listFiles(entryPath);
      }
      return SOURCE_EXTENSIONS.has(path.extname(entry.name)) ? [entryPath] : [];
    });
}

export function extractSourceReferences(source) {
  const references = [];
  const importPattern = /\b(?:from\s*|import\s*\(\s*|import\s*)["']([^"']+)["']/g;
  const reexportPattern = /\bexport\s+(\*|\{[^}]*\})\s+from\s*["']([^"']+)["']/g;

  for (const match of source.matchAll(importPattern)) {
    references.push({ kind: "import", specifier: match[1] });
  }
  for (const match of source.matchAll(reexportPattern)) {
    references.push({ kind: "reexport", isStar: match[1] === "*", specifier: match[2] });
  }

  const reexports = new Set(
    references
      .filter((reference) => reference.kind === "reexport")
      .map((reference) => reference.specifier)
  );
  return references.filter(
    (reference) => reference.kind === "reexport" || !reexports.has(reference.specifier)
  );
}

function getDeclaredDependencies(manifest) {
  const dependencies = new Set();
  for (const field of DEPENDENCY_FIELDS) {
    for (const dependencyName of Object.keys(manifest[field] ?? {})) {
      dependencies.add(dependencyName);
    }
  }
  return [...dependencies].sort((left, right) => left.localeCompare(right));
}

function discoverWorkspaceDirectories(repositoryRoot) {
  return WORKSPACE_DIRECTORIES.flatMap((parent) => {
    const parentDirectory = path.join(repositoryRoot, parent);
    if (!existsSync(parentDirectory)) {
      return [];
    }

    return readdirSync(parentDirectory, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.join(parent, entry.name))
      .filter((directory) => existsSync(path.join(repositoryRoot, directory, "package.json")))
      .sort((left, right) => left.localeCompare(right));
  });
}

export function readWorkspaceModules(repositoryRoot = REPOSITORY_ROOT) {
  const modules = discoverWorkspaceDirectories(repositoryRoot).map((directory) => {
    const manifestPath = path.join(repositoryRoot, directory, "package.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    return {
      name: manifest.name,
      directory,
      manifestPath,
      sourceDirectory: path.join(repositoryRoot, directory, "src"),
      declaredDependencies: getDeclaredDependencies(manifest),
    };
  });

  const duplicateNames = modules
    .map((module) => module.name)
    .filter((name, index, names) => names.indexOf(name) !== index);
  if (duplicateNames.length > 0) {
    throw new Error(
      `Duplicate workspace package names: ${[...new Set(duplicateNames)].join(", ")}.`
    );
  }

  return modules;
}

export function collectSourceReferences(modules) {
  return modules.flatMap((module) =>
    listFiles(module.sourceDirectory).flatMap((filePath) =>
      extractSourceReferences(readFileSync(filePath, "utf8")).map((reference) => ({
        ...reference,
        filePath,
        module,
      }))
    )
  );
}

export function workspaceImportName(specifier, workspaceNames) {
  return [...workspaceNames]
    .sort((left, right) => right.length - left.length || left.localeCompare(right))
    .find((name) => specifier === name || specifier.startsWith(`${name}/`));
}

export function findWorkspaceDependencyCycles(modules) {
  const byName = new Map(modules.map((module) => [module.name, module]));
  const state = new Map();
  const stack = [];
  const cycles = [];

  function visit(module) {
    state.set(module.name, "visiting");
    stack.push(module.name);

    for (const dependencyName of module.declaredDependencies
      .filter((dependency) => byName.has(dependency))
      .sort((left, right) => left.localeCompare(right))) {
      if (state.get(dependencyName) === "visiting") {
        const start = stack.indexOf(dependencyName);
        cycles.push([...stack.slice(start), dependencyName]);
        continue;
      }
      if (state.get(dependencyName) !== "visited") {
        visit(byName.get(dependencyName));
      }
    }

    stack.pop();
    state.set(module.name, "visited");
  }

  for (const module of [...modules].sort((left, right) => left.name.localeCompare(right.name))) {
    if (state.get(module.name) !== "visited") {
      visit(module);
    }
  }

  return cycles;
}

function isWithin(candidatePath, parentPath) {
  const relativePath = path.relative(parentPath, candidatePath);
  return relativePath === "" || (!relativePath.startsWith("..") && !path.isAbsolute(relativePath));
}

export function forbiddenPackageSourceImport({ module, filePath, specifier, appSourceRoots }) {
  if (!module.directory.startsWith("packages/")) {
    return undefined;
  }

  if (specifier === "@" || specifier.startsWith("@/")) {
    return "uses the API-private @/ alias";
  }
  if (specifier === "@sdp/api/test-support" && module.name === "@sdp/api-integration") {
    return undefined;
  }
  if (specifier === "@sdp/api-test" || specifier.startsWith("@sdp/api-test/")) {
    return "imports the retired API test alias";
  }
  if (specifier === "@sdp/api" || specifier.startsWith("@sdp/api/")) {
    return "imports API source outside @sdp/api/test-support";
  }
  if (!specifier.startsWith(".")) {
    return undefined;
  }

  const resolvedPath = path.resolve(path.dirname(filePath), specifier);
  if (appSourceRoots.some((appSourceRoot) => isWithin(resolvedPath, appSourceRoot))) {
    return "reaches into application source through a relative path";
  }

  return undefined;
}

export function validateModuleBoundaries({
  modules,
  sourceReferences,
  appSourceRoots,
  allowedAppReexports = new Set(),
}) {
  const errors = [];
  const moduleNames = new Set(modules.map((module) => module.name));
  const byName = new Map(modules.map((module) => [module.name, module]));

  for (const reference of sourceReferences) {
    const importedWorkspace = workspaceImportName(reference.specifier, moduleNames);
    if (importedWorkspace && importedWorkspace !== reference.module.name) {
      if (!reference.module.declaredDependencies.includes(importedWorkspace)) {
        errors.push(
          `${toPosixPath(reference.filePath)} imports ${reference.specifier} without declaring ${importedWorkspace}.`
        );
      }

      const importedModule = byName.get(importedWorkspace);
      if (
        reference.module.directory.startsWith("packages/") &&
        importedModule?.directory.startsWith("apps/") &&
        !(
          reference.module.name === "@sdp/api-integration" &&
          reference.specifier === "@sdp/api/test-support"
        )
      ) {
        errors.push(
          `${toPosixPath(reference.filePath)} imports application source from ${reference.specifier}.`
        );
      }

      if (
        reference.module.directory.startsWith("apps/") &&
        reference.kind === "reexport" &&
        !allowedAppReexports.has(`${reference.filePath}\0${reference.specifier}`)
      ) {
        errors.push(
          `${toPosixPath(reference.filePath)} adds an app compatibility re-export: ${reference.specifier}.`
        );
      }
    }

    const violation = forbiddenPackageSourceImport({ ...reference, appSourceRoots });
    if (violation) {
      errors.push(`${toPosixPath(reference.filePath)} ${violation}: ${reference.specifier}.`);
    }
  }

  for (const cycle of findWorkspaceDependencyCycles(modules)) {
    errors.push(`workspace dependency cycle: ${cycle.join(" -> ")}.`);
  }

  return errors.sort((left, right) => left.localeCompare(right));
}

export function renderModuleMap(modules) {
  const sortedModules = [...modules].sort((left, right) => left.name.localeCompare(right.name));
  const moduleNames = new Set(sortedModules.map((module) => module.name));
  const lines = [
    "<!-- Generated by `pnpm generate:module-map`; do not edit by hand. -->",
    "",
    "# Workspace Module Map",
    "",
    "The module graph is generated from the workspace package manifests. Source imports must use declared workspace dependencies; packages cannot import application source, and workspace dependencies must remain acyclic.",
    "",
    "## Modules",
    "",
    "| Module | Directory | Declared workspace dependencies |",
    "| --- | --- | --- |",
  ];

  for (const module of sortedModules) {
    const dependencies = module.declaredDependencies.filter((dependency) =>
      moduleNames.has(dependency)
    );
    lines.push(
      `| \`${module.name}\` | \`${toPosixPath(module.directory)}\` | ${dependencies.length ? dependencies.map((dependency) => `\`${dependency}\``).join(", ") : "None"} |`
    );
  }

  lines.push(
    "",
    "## Exceptions",
    "",
    "- `@sdp/api-integration` may import the explicit `@sdp/api/test-support` facade for integration-test setup and fixtures.",
    "- Other package-to-app source imports and app compatibility re-exports are rejected by `pnpm check:module-boundaries`.",
    ""
  );
  return lines.join("\n");
}

export function checkModuleBoundaries(repositoryRoot = REPOSITORY_ROOT, { write = false } = {}) {
  const modules = readWorkspaceModules(repositoryRoot);
  const appSourceRoots = modules
    .filter((module) => module.directory.startsWith("apps/"))
    .map((module) => module.sourceDirectory);
  const errors = validateModuleBoundaries({
    modules,
    sourceReferences: collectSourceReferences(modules),
    appSourceRoots,
    allowedAppReexports: new Set(
      EXISTING_APP_REEXPORTS.map(
        ([filePath, specifier]) => `${path.join(repositoryRoot, filePath)}\0${specifier}`
      )
    ),
  });
  const moduleMapPath = path.join(repositoryRoot, MODULE_MAP_PATH);
  const moduleMap = renderModuleMap(modules);

  if (write) {
    mkdirSync(path.dirname(moduleMapPath), { recursive: true });
    writeFileSync(moduleMapPath, moduleMap);
  } else if (!existsSync(moduleMapPath) || readFileSync(moduleMapPath, "utf8") !== moduleMap) {
    errors.push(`${MODULE_MAP_PATH} is stale. Run pnpm generate:module-map.`);
  }

  return errors.sort((left, right) => left.localeCompare(right));
}

function main() {
  const args = new Set(process.argv.slice(2));
  if ([...args].some((argument) => argument !== "--write")) {
    throw new Error("Usage: node scripts/check-module-boundaries.mjs [--write]");
  }

  const errors = checkModuleBoundaries(REPOSITORY_ROOT, { write: args.has("--write") });
  if (errors.length > 0) {
    throw new Error(
      `Module boundary check failed:\n${errors.map((error) => `- ${error}`).join("\n")}`
    );
  }
  console.log("Module boundary check passed.");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
