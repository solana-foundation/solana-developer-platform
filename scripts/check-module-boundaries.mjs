import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPOSITORY_ROOT = path.resolve(SCRIPT_DIR, "..");
const MODULE_MAP_PATH = "docs/architecture/module-map.md";
const SOURCE_EXTENSIONS = new Set([".cts", ".js", ".jsx", ".mjs", ".mts", ".ts", ".tsx"]);
const DEPENDENCY_FIELDS = [
  "dependencies",
  "devDependencies",
  "optionalDependencies",
  "peerDependencies",
];

// This is the source of truth for the allowed workspace graph and module map.
const MODULE_METADATA = [
  {
    name: "@sdp/api",
    directory: "apps/sdp-api",
    purpose: "Node.js API and application composition root.",
    allowedDependencies: [
      "@sdp/custody",
      "@sdp/earn",
      "@sdp/env-config",
      "@sdp/helius-rings",
      "@sdp/helius-rings-sdk",
      "@sdp/issuance",
      "@sdp/kamino",
      "@sdp/payments",
      "@sdp/policy",
      "@sdp/private-channels",
      "@sdp/rpc",
      "@sdp/solana",
      "@sdp/spc-escrow",
      "@sdp/spc-withdraw",
      "@sdp/types",
    ],
  },
  {
    name: "@sdp/helius-gateway",
    directory: "apps/sdp-helius-gateway",
    purpose:
      "Rust sidecar over the Helius Rings (zolana) SDK; builds unsigned Solana transactions. Built with cargo, not pnpm.",
    allowedDependencies: [],
  },
  {
    name: "sdp-docs",
    directory: "apps/sdp-docs",
    purpose: "Public documentation site and generated API reference.",
    allowedDependencies: ["@sdp/env-config", "@sdp/types"],
  },
  {
    name: "sdp-web",
    directory: "apps/sdp-web",
    purpose: "Dashboard application.",
    // @sdp/issuance is imported only through its mosaic-free `capabilities`
    // subpath (the advanced-settings catalog + lookups the editor renders).
    allowedDependencies: [
      "@sdp/issuance",
      "@sdp/policy",
      "@sdp/private-channels",
      "@sdp/solana",
      "@sdp/types",
    ],
  },
  {
    name: "@sdp/kit-augment",
    directory: "packages/kit-augment",
    purpose: "Shared @solana/kit type augmentation for the generated Codama clients.",
    allowedDependencies: [],
  },
  {
    name: "@sdp/api-integration",
    directory: "packages/sdp-api-integration",
    purpose: "Maintainer integration harness for API endpoint and provider coverage.",
    allowedDependencies: [
      "@sdp/api",
      "@sdp/private-channels",
      "@sdp/rpc",
      "@sdp/spc-escrow",
      "@sdp/types",
    ],
  },
  {
    name: "@sdp/custody",
    directory: "packages/sdp-custody",
    purpose: "Custody provider abstractions and keychain adapters.",
    allowedDependencies: ["@sdp/types"],
  },
  {
    name: "@sdp/earn",
    directory: "packages/sdp-earn",
    purpose: "Earn domain services, yield strategies, and vault-infra providers.",
    allowedDependencies: ["@sdp/payments", "@sdp/rpc", "@sdp/solana", "@sdp/types"],
  },
  {
    name: "@sdp/env-config",
    directory: "packages/sdp-env-config",
    purpose: "Runtime environment configuration and validation.",
    allowedDependencies: [],
  },
  {
    name: "@sdp/issuance",
    directory: "packages/sdp-issuance",
    purpose: "Token issuance domain services and Mosaic integration.",
    allowedDependencies: ["@sdp/payments", "@sdp/rpc", "@sdp/solana", "@sdp/types"],
  },
  {
    name: "@sdp/kamino",
    directory: "packages/sdp-kamino",
    purpose: "Kit-native Kamino K-Vault deposit/withdraw instruction plans over klend-sdk.",
    // The arrow points INWARD and only inward: this package depends on
    // @sdp/earn (for the provider contract and the catalogue client it extends),
    // and @sdp/earn must never depend back — its hourly catalogue cron would
    // then load klend-sdk (13MB, built against a different @solana/kit major).
    // That one-way edge is also why the Kamino program-id table lives in
    // @sdp/types, which both reach without a cycle.
    allowedDependencies: ["@sdp/earn", "@sdp/solana", "@sdp/types"],
  },
  {
    name: "@sdp/payments",
    directory: "packages/sdp-payments",
    purpose: "Payment domain services, fee payment, and ramp providers.",
    allowedDependencies: ["@sdp/rpc", "@sdp/solana", "@sdp/types"],
  },
  {
    name: "@sdp/policy",
    directory: "packages/sdp-policy",
    purpose: "Wallet-operation policy engine: rule evaluation and enforcement orchestration.",
    allowedDependencies: ["@sdp/solana", "@sdp/types"],
  },
  {
    name: "@sdp/helius-rings",
    directory: "packages/sdp-helius-rings",
    purpose: "Helius Rings shielded-wallet domain types, state machine, and gateway port (devnet).",
    allowedDependencies: [],
  },
  {
    name: "@sdp/helius-rings-sdk",
    directory: "packages/sdp-helius-rings-sdk",
    purpose:
      "Helius Rings gateway adapter running the Zolana SDK in process: health, identity provisioning, and shielded balance reads.",
    allowedDependencies: ["@sdp/helius-rings"],
  },
  {
    name: "@sdp/private-channels",
    directory: "packages/sdp-private-channels",
    purpose: "Solana Private Channels gateway, auth, and instance clients.",
    allowedDependencies: ["@sdp/rpc", "@sdp/types"],
  },
  {
    name: "@sdp/rpc",
    directory: "packages/sdp-rpc",
    purpose: "Solana RPC clients, errors, and relay helpers.",
    allowedDependencies: ["@sdp/types"],
  },
  {
    name: "@sdp/solana",
    directory: "packages/sdp-solana",
    purpose: "Solana transaction and token-program services.",
    allowedDependencies: ["@sdp/rpc", "@sdp/types"],
  },
  {
    name: "@sdp/spc-escrow",
    directory: "packages/sdp-spc-escrow",
    purpose: "Generated @solana/kit client for the Private Channels escrow program.",
    allowedDependencies: ["@sdp/kit-augment"],
  },
  {
    name: "@sdp/spc-withdraw",
    directory: "packages/sdp-spc-withdraw",
    purpose: "Generated @solana/kit client for the Private Channels withdraw program.",
    allowedDependencies: ["@sdp/kit-augment"],
  },
  {
    name: "@sdp/types",
    directory: "packages/sdp-types",
    purpose: "Shared runtime types, constants, and product contracts.",
    allowedDependencies: [],
  },
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

function extractImportSpecifiers(source) {
  const specifiers = new Set();
  const patterns = [
    /\bfrom\s*["']([^"']+)["']/g,
    /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g,
    /\bimport\s*["']([^"']+)["']/g,
  ];

  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) {
      specifiers.add(match[1]);
    }
  }

  return [...specifiers].sort((left, right) => left.localeCompare(right));
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
  return ["apps", "packages"].flatMap((parent) => {
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

function readModules(repositoryRoot) {
  return MODULE_METADATA.map((metadata) => {
    const manifestPath = path.join(repositoryRoot, metadata.directory, "package.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));

    if (manifest.name !== metadata.name) {
      throw new Error(
        `${toPosixPath(path.relative(repositoryRoot, manifestPath))} is ${manifest.name}, expected ${metadata.name}.`
      );
    }

    return {
      ...metadata,
      manifestPath,
      sourceDirectory: path.join(repositoryRoot, metadata.directory, "src"),
      declaredDependencies: getDeclaredDependencies(manifest),
    };
  });
}

function collectSourceImports(modules) {
  return modules.flatMap((module) =>
    listFiles(module.sourceDirectory).flatMap((filePath) =>
      extractImportSpecifiers(readFileSync(filePath, "utf8")).map((specifier) => ({
        filePath,
        module,
        specifier,
      }))
    )
  );
}

function isWithin(candidatePath, parentPath) {
  const relativePath = path.relative(parentPath, candidatePath);
  return relativePath === "" || (!relativePath.startsWith("..") && !path.isAbsolute(relativePath));
}

export function workspaceImportName(specifier, workspaceNames) {
  return [...workspaceNames]
    .sort((left, right) => right.length - left.length || left.localeCompare(right))
    .find((name) => specifier === name || specifier.startsWith(`${name}/`));
}

export function workspaceImportPath({ filePath, specifier, modules }) {
  if (!specifier.startsWith(".")) {
    return undefined;
  }

  const resolvedPath = path.resolve(path.dirname(filePath), specifier);
  return [...modules]
    .filter(
      (module) =>
        module.sourceDirectory && isWithin(resolvedPath, path.dirname(module.sourceDirectory))
    )
    .sort((left, right) => right.sourceDirectory.length - left.sourceDirectory.length)
    .at(0)?.name;
}

export function findWorkspaceDependencyCycles(modules) {
  const byName = new Map(modules.map((module) => [module.name, module]));
  const state = new Map();
  const stack = [];
  const cycles = [];

  function visit(module) {
    state.set(module.name, "visiting");
    stack.push(module.name);

    const dependencies = module.declaredDependencies
      .filter((dependency) => byName.has(dependency))
      .sort((left, right) => left.localeCompare(right));

    for (const dependencyName of dependencies) {
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

  if (specifier === "@sdp/api" || specifier.startsWith("@sdp/api/")) {
    return "imports API source outside @sdp/api/test-support";
  }

  if (specifier === "@sdp/api-test" || specifier.startsWith("@sdp/api-test/")) {
    return "imports the retired API test alias";
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

const FEE_PAYMENT_CONSTRUCTORS = new Set([
  "createFeePaymentAdapter",
  "createKoraAdapter",
  "KoraAdapter",
]);

export function forbiddenFeePaymentConstructorImport({ filePath, source, apiSourceRoot }) {
  if (!isWithin(filePath, apiSourceRoot)) return undefined;
  const relative = toPosixPath(path.relative(apiSourceRoot, filePath));
  if (
    relative === "services/sponsorship.service.ts" ||
    relative.startsWith("test/") ||
    relative.includes("/test/") ||
    relative.endsWith(".test.ts") ||
    relative.endsWith(".spec.ts")
  ) {
    return undefined;
  }

  const feePaymentSpecifier = "@sdp/payments/fee-payment(?:/[^\"']*)?";
  const opaqueImportPatterns = [
    new RegExp(String.raw`import\s+\*\s+as\s+[\w$]+\s+from\s+["']${feePaymentSpecifier}["']`),
    new RegExp(String.raw`import\s+(?!type\b)[\w$]+\s+from\s+["']${feePaymentSpecifier}["']`),
    new RegExp(
      String.raw`import\s+(?!type\b)[\w$]+\s*,[^;]*\sfrom\s+["']${feePaymentSpecifier}["']`
    ),
    new RegExp(String.raw`export\s+\*(?:\s+as\s+[\w$]+)?\s+from\s+["']${feePaymentSpecifier}["']`),
    new RegExp(String.raw`require\(\s*["']${feePaymentSpecifier}["']\s*\)`),
    new RegExp(String.raw`import\(\s*["']${feePaymentSpecifier}["']\s*\)`),
  ];
  if (opaqueImportPatterns.some((pattern) => pattern.test(source))) {
    return "uses an opaque fee-payment import that can bypass the owned sponsorship boundary";
  }

  const importPattern =
    /(?:import|export)\s*{([^}]+)}\s*from\s*["']@sdp\/payments\/fee-payment(?:\/[^"']*)?["']/g;
  for (const match of source.matchAll(importPattern)) {
    const importedNames = match[1].split(",").map(
      (entry) =>
        entry
          .trim()
          .replace(/^type\s+/, "")
          .split(/\s+as\s+/)[0]
    );
    const constructorName = importedNames.find((name) => FEE_PAYMENT_CONSTRUCTORS.has(name));
    if (constructorName)
      return `imports fee-payment constructor ${constructorName} outside the owned sponsorship boundary`;
  }
  return undefined;
}

export function validateModuleBoundaries({ modules, sourceImports, appSourceRoots }) {
  const errors = [];
  const moduleNames = new Set(modules.map((module) => module.name));

  for (const module of modules) {
    for (const dependencyName of module.declaredDependencies) {
      if (!moduleNames.has(dependencyName)) {
        continue;
      }
      if (!module.allowedDependencies.includes(dependencyName)) {
        errors.push(`${module.name} declares disallowed workspace dependency ${dependencyName}.`);
      }
    }
  }

  for (const sourceImport of sourceImports) {
    const violation = forbiddenPackageSourceImport({ ...sourceImport, appSourceRoots });
    const importedWorkspace =
      workspaceImportName(sourceImport.specifier, moduleNames) ??
      workspaceImportPath({ ...sourceImport, modules });
    if (
      importedWorkspace &&
      importedWorkspace !== sourceImport.module.name &&
      !sourceImport.module.declaredDependencies.includes(importedWorkspace) &&
      !violation
    ) {
      errors.push(
        `${toPosixPath(sourceImport.filePath)} imports ${sourceImport.specifier} without declaring ${importedWorkspace}.`
      );
    }

    if (violation) {
      errors.push(`${toPosixPath(sourceImport.filePath)} ${violation}: ${sourceImport.specifier}.`);
    }
  }

  for (const cycle of findWorkspaceDependencyCycles(modules)) {
    errors.push(`workspace dependency cycle: ${cycle.join(" -> ")}.`);
  }

  return errors.sort((left, right) => left.localeCompare(right));
}

export function renderModuleMap(modules) {
  const lines = [
    "<!-- Generated by `pnpm generate:module-map`; do not edit by hand. -->",
    "",
    "# Workspace Module Map",
    "",
    "This map is generated from the module-boundary check. It records the permitted workspace graph, not transient implementation imports.",
    "",
    "## Dependency Direction",
    "",
    "- Shared packages point only toward lower-level shared packages.",
    "- Applications compose shared packages and do not provide implementation imports to packages.",
    "- `@sdp/api-integration` is the one test-only exception: it may use the explicit `@sdp/api/test-support` facade, never private API paths.",
    "",
    "## Modules",
    "",
    "| Module | Purpose | Allowed workspace dependencies |",
    "| --- | --- | --- |",
  ];

  for (const module of [...modules].sort((left, right) => left.name.localeCompare(right.name))) {
    const dependencies = module.allowedDependencies.length
      ? module.allowedDependencies.map((dependency) => `\`${dependency}\``).join(", ")
      : "None";
    lines.push(`| \`${module.name}\` | ${module.purpose} | ${dependencies} |`);
  }

  lines.push("", "## Declared Workspace Graph", "");
  for (const module of [...modules].sort((left, right) => left.name.localeCompare(right.name))) {
    const dependencies = module.declaredDependencies.filter((dependency) =>
      modules.some((candidate) => candidate.name === dependency)
    );
    lines.push(
      `- \`${module.name}\` -> ${dependencies.length ? dependencies.map((dependency) => `\`${dependency}\``).join(", ") : "None"}`
    );
  }

  return `${lines.join("\n")}\n`;
}

function validateMetadataCoverage(repositoryRoot) {
  const documentedDirectories = MODULE_METADATA.map((module) => module.directory).sort();
  const discoveredDirectories = discoverWorkspaceDirectories(repositoryRoot);
  const missingMetadata = discoveredDirectories.filter(
    (directory) => !documentedDirectories.includes(directory)
  );
  const missingPackages = documentedDirectories.filter(
    (directory) => !discoveredDirectories.includes(directory)
  );
  const errors = [];

  if (missingMetadata.length > 0) {
    errors.push(`module metadata missing for ${missingMetadata.join(", ")}.`);
  }
  if (missingPackages.length > 0) {
    errors.push(`module metadata references missing packages: ${missingPackages.join(", ")}.`);
  }

  return errors;
}

export function checkModuleBoundaries(repositoryRoot = REPOSITORY_ROOT, { write = false } = {}) {
  const modules = readModules(repositoryRoot);
  const moduleMap = renderModuleMap(modules);
  const appSourceRoots = modules
    .filter((module) => module.directory.startsWith("apps/"))
    .map((module) => module.sourceDirectory);
  const errors = [
    ...validateMetadataCoverage(repositoryRoot),
    ...validateModuleBoundaries({
      modules,
      sourceImports: collectSourceImports(modules),
      appSourceRoots,
    }),
  ];
  const apiSourceRoot = path.join(repositoryRoot, "apps/sdp-api/src");
  for (const filePath of listFiles(apiSourceRoot)) {
    const violation = forbiddenFeePaymentConstructorImport({
      filePath,
      source: readFileSync(filePath, "utf8"),
      apiSourceRoot,
    });
    if (violation) errors.push(`${toPosixPath(filePath)} ${violation}.`);
  }
  const moduleMapPath = path.join(repositoryRoot, MODULE_MAP_PATH);

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
