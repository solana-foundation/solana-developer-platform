import {
  API_SCHEMA_TYPES,
  type ApiConstraint,
  type ApiFamily,
  type ApiMethod,
  type ApiOperation,
  type ApiParameter,
  type ApiParameterLocation,
  type ApiProperty,
  type ApiReference,
  type ApiRequestBody,
  type ApiResponse,
  type ApiSchema,
  type ApiSchemaType,
  type ApiVariant,
} from "@sdp/api-catalog/reference";
import { ACTIONS, type Action } from "@sdp/types/actions";
import type {
  OpenAPIObject,
  OperationObject,
  ParameterObject,
  ReferenceObject,
  SchemaObject,
  SecurityRequirementObject,
} from "openapi3-ts/oas30";
import { z } from "zod";
import { AppError, type ErrorCode, missingAction } from "@/lib/errors";
import {
  dereferenceParameter,
  dereferenceRequestBody,
  dereferenceResponse,
  dereferenceSchema,
  type HttpMethod,
  isHttpMethod,
  sampleFromSchema,
  toEndpointId,
} from "@/openapi/document-reader";
import { DOCS_GROUP } from "@/openapi/paths/helpers";
import routeActionsJson from "@/openapi/route-actions.generated.json";
import { routeActionKey } from "@/routes/route-actions";
import { routeOwnerOf } from "@/routes/route-modules";

/**
 * Builds the API reference model (`@sdp/api-catalog/reference`) from a release channel's public
 * OpenAPI document. Everything in it comes from that document, the route inventory and the
 * API's own errors, so the reference cannot describe a route, value or answer the channel does
 * not run. A schema keyword or document shape the model cannot carry fails the build instead of
 * dropping out of the reference.
 */

const API_METHOD_OF = {
  get: "GET",
  post: "POST",
  put: "PUT",
  patch: "PATCH",
  delete: "DELETE",
} as const satisfies Record<HttpMethod, ApiMethod>;

/** Each route's declared action, generated from the app (`pnpm -C apps/sdp-api route-actions:generate`). */
const ROUTE_ACTIONS: Readonly<Record<string, Action>> = z
  .record(z.string(), z.enum(ACTIONS))
  .parse(routeActionsJson);

const jsonValueSchema = z.json();

type Json = z.infer<typeof jsonValueSchema>;

const SCHEMA_TYPES: ReadonlySet<string> = new Set(API_SCHEMA_TYPES);

function isApiSchemaType(value: string): value is ApiSchemaType {
  return SCHEMA_TYPES.has(value);
}

/** The schema keywords the model carries. */
const SCHEMA_KEYWORDS: ReadonlySet<string> = new Set([
  "type",
  "format",
  "nullable",
  "description",
  "enum",
  "default",
  "example",
  "minLength",
  "maxLength",
  "minimum",
  "exclusiveMinimum",
  "maximum",
  "exclusiveMaximum",
  "minItems",
  "maxItems",
  "minProperties",
  "pattern",
  "not",
  "properties",
  "required",
  "additionalProperties",
  "items",
  "oneOf",
  "anyOf",
]);

/** The parameter fields the model carries. */
const PARAMETER_FIELDS: ReadonlySet<string> = new Set([
  "name",
  "in",
  "required",
  "description",
  "schema",
  "example",
]);

const PARAMETER_ORDER = {
  path: 0,
  query: 1,
  header: 2,
} as const satisfies Record<ApiParameterLocation, number>;

function isParameterLocation(value: string): value is ApiParameterLocation {
  return Object.hasOwn(PARAMETER_ORDER, value);
}

const scalarSchema = z.union([z.string(), z.number(), z.boolean()]);

function constraintsOf(schema: SchemaObject, document: OpenAPIObject, where: string) {
  const constraints: ApiConstraint[] = [];
  if (schema.minLength !== undefined) {
    constraints.push({ kind: "minLength", value: schema.minLength });
  }
  if (schema.maxLength !== undefined) {
    constraints.push({ kind: "maxLength", value: schema.maxLength });
  }
  // OpenAPI 3.0: a true `exclusiveMinimum` turns `minimum` into a bound the value must exceed.
  if (schema.minimum !== undefined) {
    const kind = schema.exclusiveMinimum === true ? "exclusiveMinimum" : "minimum";
    constraints.push({ kind, value: schema.minimum });
  }
  if (schema.maximum !== undefined) {
    const kind = schema.exclusiveMaximum === true ? "exclusiveMaximum" : "maximum";
    constraints.push({ kind, value: schema.maximum });
  }
  if (schema.minItems !== undefined) constraints.push({ kind: "minItems", value: schema.minItems });
  if (schema.maxItems !== undefined) constraints.push({ kind: "maxItems", value: schema.maxItems });
  if (schema.minProperties !== undefined) {
    constraints.push({ kind: "minProperties", value: schema.minProperties });
  }
  if (schema.pattern !== undefined) constraints.push({ kind: "pattern", value: schema.pattern });
  if (schema.not !== undefined) {
    const excluded = dereferenceSchema(schema.not, document);
    if (Object.keys(excluded).length !== 1 || excluded.required === undefined) {
      throw new Error(`${where}: the API reference renders only \`not: { required: [...] }\``);
    }
    constraints.push({ kind: "excludes", value: excluded.required });
  }
  return constraints;
}

function variantModeOf(schema: SchemaObject, where: string): ApiSchema["variantMode"] {
  if (schema.oneOf !== undefined && schema.anyOf !== undefined) {
    throw new Error(`${where}: both oneOf and anyOf`);
  }
  if (schema.oneOf !== undefined) return "oneOf";
  if (schema.anyOf !== undefined) return "anyOf";
  return null;
}

/** The value a property pins a variant to, when its enum has exactly one. */
function pinnedValue(variant: ApiSchema, name: string) {
  const values = variant.properties.find((property) => property.name === name)?.schema.enum;
  return values?.length === 1 ? values[0] : undefined;
}

/**
 * What sets each variant apart: a property every variant pins to its own value
 * (`provider: "privy"`), else the variant's description, else its type.
 */
function variantsOf(schemas: ApiSchema[], where: string): ApiVariant[] {
  const [first] = schemas;
  if (first === undefined) throw new Error(`${where}: a oneOf or anyOf with no variants`);
  const pinned = first.properties
    .map((property) => property.name)
    .find((name) => schemas.every((schema) => pinnedValue(schema, name) !== undefined));
  return schemas.map((schema, index) => {
    if (pinned !== undefined) {
      return { title: `${pinned}: ${JSON.stringify(pinnedValue(schema, pinned))}`, schema };
    }
    if (schema.description !== null) return { title: schema.description, schema };
    if (schema.type !== null) return { title: schema.type, schema };
    throw new Error(`${where}: variant ${index + 1} has no pinned value, description or type`);
  });
}

function additionalPropertiesOf(schema: SchemaObject, document: OpenAPIObject, where: string) {
  const additional = schema.additionalProperties;
  if (additional === undefined || additional === false) return null;
  // `true` admits any value, which the model writes as a schema with no type.
  return toApiSchema(additional === true ? {} : additional, document, `${where}{}`);
}

/**
 * One schema in the model's terms, recursively. Throws on a keyword the model has no place for,
 * so a constraint added to the API can never silently miss the reference.
 */
function toApiSchema(
  input: SchemaObject | ReferenceObject,
  document: OpenAPIObject,
  where: string
): ApiSchema {
  const schema = dereferenceSchema(input, document);
  for (const keyword of Object.keys(schema)) {
    if (!SCHEMA_KEYWORDS.has(keyword)) {
      throw new Error(`${where}: the API reference does not render \`${keyword}\``);
    }
  }
  const { type } = schema;
  if (type !== undefined && (Array.isArray(type) || !isApiSchemaType(type))) {
    throw new Error(`${where}: unsupported type ${JSON.stringify(type)}`);
  }
  // OpenAPI leaves an empty list out, so `?? []` reads an absent one as empty throughout.
  const required = new Set(schema.required ?? []);
  const properties: ApiProperty[] =
    schema.properties === undefined
      ? []
      : Object.entries(schema.properties).map(([name, property]) => ({
          name,
          required: required.has(name),
          schema: toApiSchema(property, document, `${where}.${name}`),
        }));
  const variantInputs = schema.oneOf ?? schema.anyOf;
  const variants =
    variantInputs === undefined
      ? []
      : variantsOf(
          variantInputs.map((variant, index) =>
            toApiSchema(variant, document, `${where}<${index + 1}>`)
          ),
          where
        );
  const node: ApiSchema = {
    type: type === undefined ? null : type,
    format: schema.format ?? null,
    nullable: schema.nullable === true,
    description: schema.description ?? null,
    enum: schema.enum === undefined ? null : z.array(scalarSchema).parse(schema.enum),
    constraints: constraintsOf(schema, document, where),
    properties,
    items: schema.items === undefined ? null : toApiSchema(schema.items, document, `${where}[]`),
    additionalProperties: additionalPropertiesOf(schema, document, where),
    variantMode: variantModeOf(schema, where),
    variants,
  };
  if (schema.default !== undefined) node.default = jsonValueSchema.parse(schema.default);
  if (schema.example !== undefined) node.example = jsonValueSchema.parse(schema.example);
  return node;
}

function toApiParameter(
  parameter: ParameterObject,
  document: OpenAPIObject,
  where: string
): ApiParameter {
  const label = `${where} ${parameter.in} parameter ${parameter.name}`;
  for (const field of Object.keys(parameter)) {
    if (!PARAMETER_FIELDS.has(field)) {
      throw new Error(`${label}: the API reference does not render \`${field}\``);
    }
  }
  if (!isParameterLocation(parameter.in)) {
    throw new Error(`${label}: the API reference renders path, query and header parameters`);
  }
  if (parameter.schema === undefined) throw new Error(`${label} has no schema`);
  const schema = toApiSchema(parameter.schema, document, label);
  if (parameter.example !== undefined) schema.example = jsonValueSchema.parse(parameter.example);
  return {
    name: parameter.name,
    in: parameter.in,
    required: parameter.in === "path" || parameter.required === true,
    description: parameter.description ?? schema.description,
    schema,
  };
}

/** A sampled parameter value as it travels in a URL, the way the playground fills its fields. */
function sampleText(parameter: ParameterObject, document: OpenAPIObject, where: string): string {
  if (parameter.schema === undefined) throw new Error(`${where}: ${parameter.name} has no schema`);
  const sample = sampleFromSchema(
    dereferenceSchema(parameter.schema, document),
    document,
    parameter.name
  );
  return typeof sample === "string" ? sample : JSON.stringify(sample);
}

/** An operation's JSON request body and its schema, or null when it takes no body. */
function jsonRequestBodyOf(operation: OperationObject, document: OpenAPIObject, where: string) {
  if (operation.requestBody === undefined) return null;
  const body = dereferenceRequestBody(operation.requestBody, document);
  const contentTypes = Object.keys(body.content);
  const media = body.content["application/json"];
  if (contentTypes.length !== 1 || media === undefined) {
    throw new Error(`${where}: the API reference renders only application/json request bodies`);
  }
  if (media.schema === undefined) throw new Error(`${where}: a request body with no schema`);
  // The samples are synthesized from the schema, as the playground does, so a media example
  // would never reach them.
  if (media.example !== undefined || media.examples !== undefined) {
    throw new Error(`${where}: request body examples belong on the schema`);
  }
  return { body, schema: media.schema };
}

function toApiRequestBody(
  jsonBody: NonNullable<ReturnType<typeof jsonRequestBodyOf>>,
  document: OpenAPIObject,
  where: string
): ApiRequestBody {
  const schema = toApiSchema(jsonBody.schema, document, `${where} body`);
  return {
    required: jsonBody.body.required === true,
    // The generator puts a body's description on its schema, as it does a parameter's.
    description: jsonBody.body.description ?? schema.description,
    contentType: "application/json",
    schema,
  };
}

/**
 * The call the samples make: path parameters filled from their samples and required query
 * parameters appended, with the body the dashboard playground starts from.
 */
function sampleRequest(
  path: string,
  parameters: ParameterObject[],
  jsonBody: ReturnType<typeof jsonRequestBodyOf>,
  document: OpenAPIObject,
  where: string
): ApiOperation["request"] {
  const filled = path.replace(/\{([^}]+)\}/g, (_match, name: string) => {
    const parameter = parameters.find((entry) => entry.in === "path" && entry.name === name);
    if (parameter === undefined) throw new Error(`${where}: no path parameter ${name}`);
    return encodeURIComponent(sampleText(parameter, document, where));
  });
  const query = new URLSearchParams(
    parameters
      .filter((parameter) => parameter.in === "query" && parameter.required === true)
      .map((parameter) => [parameter.name, sampleText(parameter, document, where)])
  ).toString();
  return {
    path: query === "" ? filled : `${filled}?${query}`,
    body:
      jsonBody === null ? null : jsonValueSchema.parse(sampleFromSchema(jsonBody.schema, document)),
  };
}

/**
 * The code an error status answers with in the reference's examples. A 422 is
 * IDEMPOTENCY_KEY_REUSED where the route takes an Idempotency-Key and SIGNING_REJECTED elsewhere,
 * the two codes the API answers 422 with. `reference.test.ts` checks each code's status.
 */
export function exampleErrorCode(
  status: string,
  takesIdempotencyKey: boolean,
  where: string
): ErrorCode {
  switch (status) {
    case "400":
      return "BAD_REQUEST";
    case "401":
      return "UNAUTHORIZED";
    case "403":
      return "FORBIDDEN";
    case "404":
      return "NOT_FOUND";
    case "409":
      return "CONFLICT";
    case "422":
      return takesIdempotencyKey ? "IDEMPOTENCY_KEY_REUSED" : "SIGNING_REJECTED";
    case "429":
      return "RATE_LIMITED";
    case "500":
      return "INTERNAL_ERROR";
    case "502":
      return "SOLANA_RPC_ERROR";
    case "503":
      return "SERVICE_UNAVAILABLE";
    default:
      throw new Error(`${where} documents a ${status}, which has no example error code`);
  }
}

const errorEnvelopeSampleSchema = z.object({ error: z.json() }).catchall(z.json());

/** The codes an error envelope's schema allows, or null when the schema is not the envelope. */
function envelopeCodes(schema: SchemaObject, document: OpenAPIObject): ReadonlySet<string> | null {
  const error = schema.properties?.error;
  if (error === undefined) return null;
  const code = dereferenceSchema(error, document).properties?.code;
  if (code === undefined) return null;
  const codes = dereferenceSchema(code, document).enum;
  return codes === undefined ? null : new Set(z.array(z.string()).parse(codes));
}

/**
 * An error answer as the API sends it: the envelope sampled from its schema, with the error the
 * route raises for that status (`missingAction` for a 403 on a route with an action).
 */
function errorExample(
  schema: SchemaObject,
  status: string,
  action: Action | null,
  takesIdempotencyKey: boolean,
  document: OpenAPIObject,
  where: string
): Json {
  const codes = envelopeCodes(schema, document);
  if (codes === null) return jsonValueSchema.parse(sampleFromSchema(schema, document));
  const error =
    status === "403" && action !== null
      ? missingAction(action)
      : new AppError(exampleErrorCode(status, takesIdempotencyKey, where));
  if (String(error.statusCode) !== status || !codes.has(error.code)) {
    throw new Error(`${where}: ${error.code} is not an answer the document allows for a ${status}`);
  }
  const envelope = errorEnvelopeSampleSchema.parse(sampleFromSchema(schema, document));
  return { ...envelope, error: jsonValueSchema.parse(error.toResponse().error) };
}

function toApiResponses(
  operation: OperationObject,
  action: Action | null,
  takesIdempotencyKey: boolean,
  document: OpenAPIObject,
  where: string
): ApiResponse[] {
  return Object.entries(operation.responses)
    .map(([status, input]): ApiResponse => {
      if (!/^[1-5]\d\d$/.test(status)) {
        throw new Error(`${where}: the API reference renders numeric statuses, not ${status}`);
      }
      const response = dereferenceResponse(input, document);
      const contentTypes = Object.keys(response.content ?? {});
      if (contentTypes.length === 0) {
        return { status, description: response.description, body: { kind: "empty" } };
      }
      const schema = response.content?.["application/json"]?.schema;
      if (contentTypes.length !== 1 || schema === undefined) {
        throw new Error(`${where} ${status}: the API reference renders only JSON responses`);
      }
      const resolved = dereferenceSchema(schema, document);
      const example = /^[45]/.test(status)
        ? errorExample(
            resolved,
            status,
            action,
            takesIdempotencyKey,
            document,
            `${where} ${status}`
          )
        : jsonValueSchema.parse(sampleFromSchema(resolved, document));
      return { status, description: response.description, body: { kind: "json", example } };
    })
    .sort((left, right) => Number(left.status) - Number(right.status));
}

/** The public document sets no top-level security, so an operation with none of its own is public. */
function authOf(
  security: SecurityRequirementObject[] | undefined,
  document: OpenAPIObject,
  where: string
): ApiOperation["auth"] {
  const requirements = security ?? document.security;
  if (requirements === undefined || requirements.length === 0) return "none";
  const apiKeyOnly = requirements.every(
    (requirement) => Object.keys(requirement).length === 1 && "apiKeyAuth" in requirement
  );
  if (!apiKeyOnly) throw new Error(`${where}: a security requirement other than apiKeyAuth`);
  return "apiKey";
}

const docsGroupSchema = z.string().trim().min(1).optional();

/** The group an operation names within its tag (`DOCS_GROUP`), or null when it names none. */
function docsGroupOf(operation: OperationObject, where: string): string | null {
  const group = docsGroupSchema.safeParse(operation[DOCS_GROUP]);
  if (!group.success) throw new Error(`${where}: ${DOCS_GROUP} must name a group`);
  return group.data ?? null;
}

function toApiOperation(
  path: string,
  method: HttpMethod,
  operation: OperationObject,
  pathParameters: (ParameterObject | ReferenceObject)[],
  document: OpenAPIObject
): ApiOperation {
  const where = `${API_METHOD_OF[method]} ${path}`;
  const { operationId, summary } = operation;
  if (operationId === undefined || summary === undefined) {
    throw new Error(`${where} needs an operationId and a summary`);
  }
  const module = routeOwnerOf(path);
  if (module === undefined) {
    throw new Error(`${where} has no owning module in src/routes/route-modules.ts`);
  }
  const action = ROUTE_ACTIONS[routeActionKey(method, path)] ?? null;
  const parameters = [...pathParameters, ...(operation.parameters ?? [])].map((parameter) =>
    dereferenceParameter(parameter, document)
  );
  const takesIdempotencyKey = parameters.some(
    (parameter) => parameter.in === "header" && parameter.name === "Idempotency-Key"
  );
  const jsonBody = jsonRequestBodyOf(operation, document, where);
  return {
    operationId,
    endpointId: toEndpointId(operationId),
    method: API_METHOD_OF[method],
    path,
    module,
    action,
    auth: authOf(operation.security, document, where),
    summary,
    group: docsGroupOf(operation, where),
    description: operation.description ?? null,
    deprecated: operation.deprecated === true,
    parameters: parameters
      .map((parameter) => toApiParameter(parameter, document, where))
      .sort((left, right) => PARAMETER_ORDER[left.in] - PARAMETER_ORDER[right.in]),
    requestBody: jsonBody === null ? null : toApiRequestBody(jsonBody, document, where),
    responses: toApiResponses(operation, action, takesIdempotencyKey, document, where),
    request: sampleRequest(path, parameters, jsonBody, document, where),
  };
}

/**
 * The reference model for a public OpenAPI document: one family per declared tag that an
 * operation uses, in the document's tag order, each with its operations in document order. An
 * operation's family is its first tag; an untagged operation, or one whose tag the document does
 * not declare with a description, fails the build.
 */
export function buildApiReference(document: OpenAPIObject): ApiReference {
  const operationsByTag = new Map<string, ApiOperation[]>();
  for (const [path, item] of Object.entries(document.paths)) {
    for (const key of Object.keys(item)) {
      if (!isHttpMethod(key)) continue;
      const operation = item[key];
      if (operation === undefined) continue;
      const [tag] = operation.tags ?? [];
      if (tag === undefined) {
        throw new Error(`${API_METHOD_OF[key]} ${path} has no tag, so it belongs to no API family`);
      }
      const built = toApiOperation(path, key, operation, item.parameters ?? [], document);
      operationsByTag.set(tag, [...(operationsByTag.get(tag) ?? []), built]);
    }
  }
  const declared = new Set((document.tags ?? []).map((tag) => tag.name));
  for (const tag of operationsByTag.keys()) {
    if (!declared.has(tag)) throw new Error(`Operations use the undeclared tag ${tag}`);
  }
  const families: ApiFamily[] = (document.tags ?? []).flatMap((tag) => {
    const operations = operationsByTag.get(tag.name);
    if (operations === undefined) return [];
    if (tag.description === undefined) throw new Error(`Tag ${tag.name} has no description`);
    const grouped = operations.filter((operation) => operation.group !== null).length;
    if (grouped !== 0 && grouped !== operations.length) {
      throw new Error(
        `${tag.name}: ${grouped} of ${operations.length} operations name a ${DOCS_GROUP}; name one on each or none`
      );
    }
    return [{ name: tag.name, description: tag.description, operations }];
  });
  return { families };
}
