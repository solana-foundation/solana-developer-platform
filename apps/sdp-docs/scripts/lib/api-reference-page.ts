import { STATUS_CODES } from "node:http";
import {
  API_PARAMETER_LOCATIONS,
  type ApiConstraint,
  type ApiFamily,
  type ApiOperation,
  type ApiParameter,
  type ApiParameterLocation,
  type ApiRequestBody,
  type ApiResponse,
  type ApiSchema,
} from "@sdp/api-catalog/reference";
import { buildSnippets, SNIPPET_LANGUAGES, type SnippetLanguage } from "@sdp/api-catalog/snippets";
import { stringify as stringifyYaml } from "yaml";
import { canonicalSite } from "@/lib/site";

/**
 * One API reference page per family, as Markdown-first MDX: every operation is an `##` section
 * anchored by its operationId, with its parameters, request body, responses, a cURL, TypeScript
 * and Python sample and an example per status. The page renders, searches and serves as `.md`
 * from the same text; the one component, `<ApiEndpoint />`, has its Markdown form in
 * `expandDocsBlocks` (`src/lib/docs-blocks.ts`).
 */

const SNIPPET_FENCES = {
  curl: { language: "bash", tab: "cURL" },
  ts: { language: "ts", tab: "TypeScript" },
  py: { language: "python", tab: "Python" },
} as const satisfies Record<SnippetLanguage, { language: string; tab: string }>;

function sampleTabMarker(language: SnippetLanguage): string {
  return `tab="${SNIPPET_FENCES[language].tab}"`;
}

/** The fence meta each operation's three samples carry, which `generate:api` checks for. */
export const SAMPLE_TAB_MARKERS = SNIPPET_LANGUAGES.map(sampleTabMarker);

const PARAMETER_HEADINGS = {
  path: "Path parameters",
  query: "Query parameters",
  header: "Headers",
} as const satisfies Record<ApiParameterLocation, string>;

/** How `errorResponses()` (apps/sdp-api/src/openapi/paths/helpers.ts) describes every error. */
const GENERIC_ERROR_DESCRIPTION = "Error";

const AUTHENTICATION_GUIDE = "/docs/developing-with-sdp/authentication";

/** Text from the document as MDX: outside a code span, `{`, `}` and `<` would open JSX. */
export function mdxText(value: string): string {
  return value
    .split(/(`+[^`]+`+)/)
    .map((part, index) => (index % 2 === 1 ? part : part.replace(/[{}<]/g, (char) => `\\${char}`)))
    .join("");
}

/** An inline code span holding `value` verbatim, whatever backticks it contains. */
export function codeSpan(value: string): string {
  const longestRun = Math.max(0, ...(value.match(/`+/g) ?? []).map((run) => run.length));
  const ticks = "`".repeat(longestRun + 1);
  const padded = value.startsWith("`") || value.endsWith("`") ? ` ${value} ` : value;
  return `${ticks}${padded}${ticks}`;
}

function fence(language: string, meta: string, body: string): string {
  const longestRun = Math.max(0, ...(body.match(/`{3,}/g) ?? []).map((run) => run.length));
  const ticks = "`".repeat(Math.max(3, longestRun + 1));
  return `${ticks}${language} ${meta}\n${body}\n${ticks}`;
}

/** `text` indented `depth` list levels, two spaces each; blank lines stay empty. */
function indented(text: string, depth: number): string {
  const pad = "  ".repeat(depth);
  return text
    .split("\n")
    .map((line) => (line === "" ? "" : `${pad}${line}`))
    .join("\n");
}

function typeLabel(schema: ApiSchema): string {
  const nullable = schema.nullable ? " | null" : "";
  if (schema.type === "array") {
    if (schema.items === null) return `array${nullable}`;
    const item = typeLabel(schema.items);
    return `${item.includes(" ") ? `(${item})` : item}[]${nullable}`;
  }
  if (schema.type !== null) return `${schema.type}${nullable}`;
  const variants = [...new Set(schema.variants.map((variant) => typeLabel(variant.schema)))];
  return `${variants.length > 0 ? variants.join(" | ") : "any"}${nullable}`;
}

function constraintText(constraint: ApiConstraint): string {
  switch (constraint.kind) {
    case "minLength":
      return `min length ${constraint.value}`;
    case "maxLength":
      return `max length ${constraint.value}`;
    case "minimum":
      return `min ${constraint.value}`;
    case "exclusiveMinimum":
      return `greater than ${constraint.value}`;
    case "maximum":
      return `max ${constraint.value}`;
    case "exclusiveMaximum":
      return `less than ${constraint.value}`;
    case "minItems":
      return `min items ${constraint.value}`;
    case "maxItems":
      return `max items ${constraint.value}`;
    case "minProperties":
      return `min properties ${constraint.value}`;
    case "pattern":
      return `pattern ${codeSpan(constraint.value)}`;
    case "excludes":
      return `must not include ${constraint.value.map(codeSpan).join(", ")}`;
    default: {
      const unknown: never = constraint;
      throw new Error(`Unknown constraint ${JSON.stringify(unknown)}`);
    }
  }
}

type JsonValue = Exclude<ApiSchema["example"], undefined>;

/** A scalar example or default as code; objects and arrays show in the request sample instead. */
function scalarCode(value: JsonValue): string | null {
  if (typeof value === "string") return codeSpan(value);
  if (typeof value === "number" || typeof value === "boolean" || value === null) {
    return codeSpan(JSON.stringify(value));
  }
  return null;
}

/** Format, bounds, allowed values, default and example, in that order. */
function schemaFacts(schema: ApiSchema): string[] {
  const facts: string[] = [];
  if (schema.format !== null) facts.push(`format ${codeSpan(schema.format)}`);
  facts.push(...schema.constraints.map(constraintText));
  if (schema.enum !== null) {
    facts.push(`one of ${schema.enum.map((value) => codeSpan(String(value))).join(", ")}`);
  }
  const defaultValue = schema.default === undefined ? null : scalarCode(schema.default);
  if (defaultValue !== null) facts.push(`default ${defaultValue}`);
  const example = schema.example === undefined ? null : scalarCode(schema.example);
  if (example !== null) facts.push(`example ${example}`);
  // An array of plain values: what each item must be.
  if (schema.type === "array" && schema.items !== null && schema.items.properties.length === 0) {
    facts.push(...schemaFacts(schema.items).map((fact) => `each ${fact}`));
  }
  return facts;
}

function variantLead(mode: ApiSchema["variantMode"]): string {
  switch (mode) {
    case "oneOf":
      return "One of:";
    case "anyOf":
      return "Any of:";
    case null:
      throw new Error("Variants with no oneOf or anyOf");
    default: {
      const unknown: never = mode;
      throw new Error(`Unknown variant mode ${JSON.stringify(unknown)}`);
    }
  }
}

/** The fields a value is made of: properties, a map's values, an array's items, or variants. */
function childLines(schema: ApiSchema, depth: number): string[] {
  const lines: string[] = [];
  for (const property of schema.properties) {
    lines.push(
      ...fieldLines(
        codeSpan(property.name),
        property.required,
        property.schema,
        property.schema.description,
        depth
      )
    );
  }
  if (schema.additionalProperties !== null) {
    lines.push(
      ...fieldLines(
        codeSpan("*"),
        false,
        schema.additionalProperties,
        schema.additionalProperties.description,
        depth
      )
    );
  }
  if (schema.items !== null && schema.items.properties.length > 0) {
    lines.push(...childLines(schema.items, depth));
  }
  if (schema.variants.length > 0) {
    lines.push(indented(variantLead(schema.variantMode), depth), "");
    for (const variant of schema.variants) {
      const head = [`**${mdxText(variant.title)}**`, ...schemaFacts(variant.schema)].join(" · ");
      lines.push(indented(`- ${head}`, depth), "");
      lines.push(...childLines(variant.schema, depth + 1));
    }
  }
  return lines;
}

/**
 * One field as a list item: name, type and facts on the first line, the description below, and
 * nested fields as a list inside it.
 */
function fieldLines(
  label: string,
  required: boolean,
  schema: ApiSchema,
  description: string | null,
  depth: number
): string[] {
  const head = [`**${label}**`, codeSpan(typeLabel(schema))];
  if (required) head.push("required");
  head.push(...schemaFacts(schema));
  const lines = [indented(`- ${head.join(" · ")}`, depth), ""];
  if (description !== null) lines.push(indented(mdxText(description), depth + 1), "");
  lines.push(...childLines(schema, depth + 1));
  return lines;
}

function parameterLines(parameter: ApiParameter): string[] {
  return fieldLines(
    codeSpan(parameter.name),
    parameter.required,
    parameter.schema,
    parameter.description,
    0
  );
}

function parameterSections(parameters: ApiParameter[]): string[] {
  return API_PARAMETER_LOCATIONS.flatMap((location) => {
    const located = parameters.filter((parameter) => parameter.in === location);
    if (located.length === 0) return [];
    return [`### ${PARAMETER_HEADINGS[location]}`, "", ...located.flatMap(parameterLines)];
  });
}

function requestBodySection(body: ApiRequestBody): string[] {
  const facts = [codeSpan(body.contentType)];
  if (body.required) facts.push("required");
  const lines = ["### Request body", "", facts.join(" · "), ""];
  if (body.description !== null) lines.push(mdxText(body.description), "");
  lines.push(...childLines(body.schema, 0));
  return lines;
}

function statusText(status: string): string {
  const text = STATUS_CODES[status];
  if (text === undefined) throw new Error(`No reason phrase for HTTP status ${status}`);
  return text;
}

function responseLine(response: ApiResponse): string {
  const description =
    response.description === GENERIC_ERROR_DESCRIPTION
      ? statusText(response.status)
      : response.description;
  return `- **${codeSpan(response.status)}** ${mdxText(description).replace(/\n+/g, " ")}`;
}

function authLine(operation: ApiOperation): string {
  switch (operation.auth) {
    case "none":
      return "Public: this route takes no API key.";
    case "apiKey":
      return operation.action === null
        ? `Requires an [API key](${AUTHENTICATION_GUIDE}).`
        : `Requires an [API key](${AUTHENTICATION_GUIDE}) with the ${codeSpan(operation.action)} action.`;
    default: {
      const unknown: never = operation.auth;
      throw new Error(`Unknown auth mode ${JSON.stringify(unknown)}`);
    }
  }
}

function sampleFences(operation: ApiOperation): string[] {
  const snippets = buildSnippets({
    method: operation.method,
    url: `${canonicalSite.apiUrl}${operation.request.path}`,
    body: operation.request.body,
    auth: operation.auth,
  });
  return SNIPPET_LANGUAGES.flatMap((language) => {
    const fenceLanguage = SNIPPET_FENCES[language].language;
    return [fence(fenceLanguage, sampleTabMarker(language), snippets[language]), ""];
  });
}

function exampleResponseFences(responses: ApiResponse[]): string[] {
  return responses.flatMap((response) => {
    if (response.body.kind === "empty") return [];
    return [
      fence("json", `tab="${response.status}"`, JSON.stringify(response.body.example, null, 2)),
      "",
    ];
  });
}

export function renderOperation(operation: ApiOperation): string {
  const lines = [
    `## ${mdxText(operation.summary)} [#${operation.operationId}]`,
    "",
    `<ApiEndpoint method="${operation.method}" path="${operation.path}" />`,
    "",
  ];
  if (operation.deprecated) lines.push("**Deprecated.**", "");
  if (operation.description !== null) lines.push(mdxText(operation.description), "");
  lines.push(authLine(operation), "");
  lines.push(...parameterSections(operation.parameters));
  if (operation.requestBody !== null) lines.push(...requestBodySection(operation.requestBody));
  lines.push("### Responses", "", ...operation.responses.map(responseLine), "");
  lines.push("### Example request", "", ...sampleFences(operation));
  const examples = exampleResponseFences(operation.responses);
  if (examples.length > 0) lines.push("### Example responses", "", ...examples);
  return lines
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** One line of YAML: plain where it can be, quoted only where YAML needs it. */
function yamlScalar(value: string): string {
  return stringifyYaml(value, { lineWidth: 0 }).trimEnd();
}

/**
 * A family's page. `apiReference: true` keeps its table of contents to the operations and scopes
 * the reference styles (`src/app/docs/[[...slug]]/page.tsx`).
 */
export function renderFamilyPage(family: ApiFamily): string {
  return [
    "---",
    `title: ${yamlScalar(family.name)}`,
    `description: ${yamlScalar(family.description)}`,
    "apiReference: true",
    "---",
    "",
    family.operations.map(renderOperation).join("\n\n"),
    "",
  ].join("\n");
}
