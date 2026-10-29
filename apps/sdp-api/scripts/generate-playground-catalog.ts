import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  listApiCatalogOperations,
  PLAYGROUND_FAMILY_SECTIONS,
  type PlaygroundEndpoint,
  type PlaygroundModule,
  toPlaygroundEndpoint,
} from "@sdp/api-catalog/catalog";
import type { ApiMethod } from "@sdp/api-catalog/reference";
import { buildApiReference } from "@/openapi/reference";
import { valueGates } from "@/openapi/release-channel-values";
import routeActionsJson from "@/openapi/route-actions.generated.json";
import { createPublicOpenApiDocument } from "@/openapi/spec";
import type { RouteOwner } from "@/routes/route-modules";

type GeneratedPlaygroundOperation = PlaygroundEndpoint & {
  releaseModule: RouteOwner;
  shadowedBy: string[];
};

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptDirectory, "../../..");
const outputPath = path.resolve(
  scriptDirectory,
  "../../../packages/sdp-api-catalog/src/generated/playground-catalog.json"
);

/** A route's segments, with either parameter syntax represented by null. */
function routeSegments(template: string): (string | null)[] {
  return template
    .split("/")
    .map((segment) => (segment.startsWith("{") || segment.startsWith(":") ? null : segment));
}

/** A `route-actions.generated.json` key, `METHOD /path`. */
function parseRouteOperation(operation: string): { method: string; path: string } {
  const match = /^([A-Z]+) (\/\S*)$/.exec(operation);
  if (match === null) {
    throw new Error(`route-actions.generated.json has a malformed operation: ${operation}`);
  }
  const [, method, path] = match;
  if (method === undefined || path === undefined) {
    throw new Error(`route-actions.generated.json has a malformed operation: ${operation}`);
  }
  return { method, path };
}

/** Literal routes that the API would match before a parameter in this operation's path. */
function shadowingRoutes(method: ApiMethod, template: string): string[] {
  const own = routeSegments(template);
  return Object.keys(routeActionsJson)
    .map(parseRouteOperation)
    .filter((route) => route.method === method)
    .map((route) => route.path)
    .filter((routePath) => {
      const theirs = routeSegments(routePath);
      if (theirs.length !== own.length) return false;
      let literalOverParameter = false;
      for (const [index, segment] of own.entries()) {
        const other = theirs[index];
        if (segment !== null && other !== null && segment !== other) return false;
        if (segment === null && other !== null) literalOverParameter = true;
        if (segment !== null && other === null) return false;
      }
      return literalOverParameter;
    })
    .map((routePath) => routePath.replace(/:[^/]+/g, "{_}"))
    .sort();
}

function generateCatalog(): string {
  const reference = buildApiReference(
    createPublicOpenApiDocument({ releaseChannel: "experimental" })
  );
  const modules: Record<PlaygroundModule, GeneratedPlaygroundOperation[]> = {
    wallets: [],
    payments: [],
    counterparties: [],
    issuance: [],
  };

  for (const { family, operation } of listApiCatalogOperations(reference)) {
    const section = PLAYGROUND_FAMILY_SECTIONS.get(family);
    if (section === undefined) continue;
    modules[section].push({
      ...toPlaygroundEndpoint(operation),
      releaseModule: operation.module,
      shadowedBy: shadowingRoutes(operation.method, operation.path),
    });
  }

  return `${JSON.stringify(
    {
      _generated: {
        source: "apps/sdp-api/src/openapi/**",
        command: "pnpm -C apps/sdp-api playground:generate",
        families: Object.fromEntries(
          reference.families.map((family) => [family.name, family.operations.length])
        ),
        modules: Object.fromEntries(
          Object.entries(modules).map(([module, endpoints]) => [module, endpoints.length])
        ),
      },
      // The dashboard's allowlist stays on its four existing sections. The
      // shared reference contains every public operation, including Health and Projects.
      modules,
      valueGates: valueGates(),
    },
    null,
    2
  )}\n`;
}

function formatCatalog(catalog: string): string {
  return execFileSync(
    "pnpm",
    ["--dir", repositoryRoot, "exec", "biome", "format", "--stdin-file-path", outputPath],
    { input: catalog, encoding: "utf8" }
  );
}

const expected = formatCatalog(generateCatalog());
if (process.argv.includes("--check")) {
  const current = await readFile(outputPath, "utf8").catch(() => "");
  if (current !== expected) {
    process.stderr.write(
      "API playground catalog is stale. Run: pnpm -C apps/sdp-api playground:generate\n"
    );
    process.exitCode = 1;
  }
} else {
  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, expected, "utf8");
  process.stdout.write(`API playground catalog generated at ${outputPath}\n`);
}
