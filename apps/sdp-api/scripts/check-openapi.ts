import { createOpenApiDocument } from "../src/openapi/spec";

const doc = createOpenApiDocument();
const methods = ["get", "post", "put", "patch", "delete", "head", "options", "trace"] as const;

const errors: string[] = [];
const operationIds = new Map<string, string>();

for (const [path, pathItem] of Object.entries(doc.paths ?? {})) {
  if (!pathItem) {
    continue;
  }

  for (const method of methods) {
    const operation = (pathItem as Record<string, unknown>)[method] as
      | {
          operationId?: string;
          summary?: string;
          description?: string;
          tags?: string[];
        }
      | undefined;

    if (!operation) {
      continue;
    }

    if (!operation.operationId || operation.operationId.trim().length === 0) {
      errors.push(`${method.toUpperCase()} ${path} missing operationId`);
    } else {
      const existing = operationIds.get(operation.operationId);
      if (existing) {
        errors.push(
          `${method.toUpperCase()} ${path} operationId "${operation.operationId}" duplicates ${existing}`
        );
      } else {
        operationIds.set(operation.operationId, `${method.toUpperCase()} ${path}`);
      }
    }

    if (!operation.summary || operation.summary.trim().length === 0) {
      errors.push(`${method.toUpperCase()} ${path} missing summary`);
    }

    if (!operation.description || operation.description.trim().length === 0) {
      errors.push(`${method.toUpperCase()} ${path} missing description`);
    }

    if (!operation.tags || operation.tags.length === 0) {
      errors.push(`${method.toUpperCase()} ${path} missing tags`);
    }
  }
}

if (errors.length > 0) {
  throw new Error(`OpenAPI validation failed:\n${errors.join("\n")}`);
}

console.log("OpenAPI validation passed.");
