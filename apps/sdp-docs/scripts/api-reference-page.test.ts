import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ApiOperation, ApiSchema } from "@sdp/api-catalog/reference";
import remarkMdx from "remark-mdx";
import remarkParse from "remark-parse";
import { unified } from "unified";
import { expandDocsBlocks, remarkDocsBlocks } from "@/lib/docs-blocks";
import { publicSurface } from "@/lib/release-channel";
import {
  codeSpan,
  mdxText,
  renderFamilyPage,
  renderOperation,
} from "@/scripts/lib/api-reference-page";

function schema(overrides: Partial<ApiSchema>): ApiSchema {
  return {
    type: "string",
    format: null,
    nullable: false,
    description: null,
    enum: null,
    constraints: [],
    properties: [],
    items: null,
    additionalProperties: null,
    variantMode: null,
    variants: [],
    ...overrides,
  };
}

const ERROR_EXAMPLE = {
  error: { code: "NOT_FOUND", message: "Resource not found" },
  meta: { requestId: "req_example" },
};

const CREATE_WIDGET: ApiOperation = {
  operationId: "createWidget",
  endpointId: "create-widget",
  method: "POST",
  path: "/v1/widgets/{widgetId}",
  module: "custody",
  action: "wallets.manage",
  auth: "apiKey",
  summary: "Create widget",
  description: "Creates a widget {once}, with `{braces}` in code.",
  deprecated: false,
  parameters: [
    {
      name: "widgetId",
      in: "path",
      required: true,
      description: "Widget ID.",
      schema: schema({ example: "wdg_1", constraints: [{ kind: "minLength", value: 1 }] }),
    },
    {
      name: "page",
      in: "query",
      required: false,
      description: null,
      schema: schema({
        type: "integer",
        constraints: [{ kind: "exclusiveMinimum", value: 0 }],
        default: 1,
      }),
    },
  ],
  requestBody: {
    required: true,
    description: "The widget.",
    contentType: "application/json",
    schema: schema({
      type: "object",
      properties: [
        {
          name: "kind",
          required: true,
          schema: schema({ enum: ["round", "square"], description: "Its shape." }),
        },
        {
          name: "size",
          required: false,
          schema: schema({
            type: null,
            variantMode: "anyOf",
            variants: [
              { title: "string", schema: schema({}) },
              { title: "integer", schema: schema({ type: "integer" }) },
            ],
          }),
        },
        {
          name: "tags",
          required: false,
          schema: schema({ type: "array", items: schema({ enum: ["a", "b"] }) }),
        },
      ],
    }),
  },
  responses: [
    { status: "201", description: "Created it", body: { kind: "json", example: { id: "wdg_1" } } },
    { status: "204", description: "No body", body: { kind: "empty" } },
    { status: "404", description: "Error", body: { kind: "json", example: ERROR_EXAMPLE } },
  ],
  request: { path: "/v1/widgets/wdg_1", body: { kind: "round" } },
};

describe("renderOperation", () => {
  const markdown = renderOperation(CREATE_WIDGET);

  it("anchors the section by its operationId and leads with the endpoint", () => {
    assert.ok(markdown.startsWith("## Create widget [#createWidget]\n"));
    assert.ok(markdown.includes('<ApiEndpoint method="POST" path="/v1/widgets/{widgetId}" />'));
    assert.ok(
      markdown.includes(
        "Requires an [API key](/docs/developing-with-sdp/authentication) with the `wallets.manage` action."
      )
    );
  });

  it("escapes MDX outside code spans only", () => {
    assert.ok(markdown.includes("Creates a widget \\{once\\}, with `{braces}` in code."));
  });

  it("lists parameters by location with their facts", () => {
    assert.ok(markdown.includes("### Path parameters"));
    assert.ok(
      markdown.includes(
        "- **`widgetId`** · `string` · required · min length 1 · example `wdg_1`\n\n  Widget ID."
      )
    );
    assert.ok(markdown.includes("- **`page`** · `integer` · greater than 0 · default `1`"));
    assert.ok(!markdown.includes("### Headers"));
  });

  it("nests body fields, variants and array items", () => {
    assert.ok(markdown.includes("`application/json` · required\n\nThe widget."));
    assert.ok(
      markdown.includes(
        "- **`kind`** · `string` · required · one of `round`, `square`\n\n  Its shape."
      )
    );
    assert.ok(
      markdown.includes("- **`size`** · `string | integer`\n\n  Any of:\n\n  - **string**")
    );
    assert.ok(markdown.includes("- **`tags`** · `string[]` · each one of `a`, `b`"));
  });

  it("lists every status, and gives each JSON answer a response tab", () => {
    assert.ok(
      markdown.includes("- **`201`** Created it\n- **`204`** No body\n- **`404`** Not Found")
    );
    for (const tab of [
      'tab="cURL"',
      'tab="TypeScript"',
      'tab="Python"',
      'tab="201"',
      'tab="404"',
    ]) {
      assert.ok(markdown.includes(tab), tab);
    }
    assert.ok(!markdown.includes('tab="204"'));
    assert.ok(markdown.includes("curl -X POST 'https://api.solana.com/v1/widgets/wdg_1'"));
  });

  it("samples a public route without a key", () => {
    const health = renderOperation({
      ...CREATE_WIDGET,
      method: "GET",
      auth: "none",
      action: null,
      requestBody: null,
      request: { path: "/health", body: null },
    });
    assert.ok(health.includes("Public: this route takes no API key."));
    assert.ok(!health.includes("SDP_API_KEY"));
  });
});

describe("renderFamilyPage", () => {
  it("writes plain frontmatter that keeps the table of contents to operations", () => {
    const page = renderFamilyPage({
      name: "Widgets",
      description: "Widget endpoints.",
      operations: [CREATE_WIDGET],
    });
    assert.ok(
      page.startsWith(
        "---\ntitle: Widgets\ndescription: Widget endpoints.\napiReference: true\n---\n\n## Create widget"
      )
    );
  });
});

describe("Markdown helpers", () => {
  it("fences a code span around backticks", () => {
    assert.equal(codeSpan("plain"), "`plain`");
    assert.equal(codeSpan("a`b"), "``a`b``");
    assert.equal(codeSpan("`edge`"), "`` `edge` ``");
  });

  it("leaves text without MDX syntax as it is", () => {
    assert.equal(mdxText("Plain text, `code` and a <tag>"), "Plain text, `code` and a \\<tag>");
  });
});

describe("<ApiEndpoint />", () => {
  const page =
    '---\ntitle: Widgets\n---\n\n<ApiEndpoint method="GET" path="/v1/widgets/{widgetId}" />\n';

  it("is `METHOD /path` in the Markdown agents and the llms files get", () => {
    assert.equal(
      expandDocsBlocks(page, "widgets.mdx"),
      "---\ntitle: Widgets\n---\n\n`GET /v1/widgets/{widgetId}`\n"
    );
  });

  it("stays a component on the page, with the same text for search", () => {
    const tree = unified()
      .use(remarkParse)
      .use(remarkMdx)
      .parse(page.replace(/^---[\s\S]*?---\n/, ""));
    remarkDocsBlocks({ surface: publicSurface })(tree, { path: "widgets.mdx" });
    const [element] = tree.children;
    assert.equal(element?.type, "mdxJsxFlowElement");
    assert.deepEqual(element?.data?._stringify, { text: "GET /v1/widgets/{widgetId}" });
  });

  it("refuses a method the API does not use", () => {
    assert.throws(() =>
      expandDocsBlocks('<ApiEndpoint method="TRACE" path="/health" />\n', "bad.mdx")
    );
  });
});
