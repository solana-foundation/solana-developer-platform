import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ApiOperation, ApiSchema } from "@sdp/api-catalog/reference";
import { structure } from "fumadocs-core/mdx-plugins/remark-structure";
import remarkMdx from "remark-mdx";
import remarkParse from "remark-parse";
import { unified } from "unified";
import { expandDocsBlocks, remarkDocsBlocks, stripMdxEsm } from "@/lib/docs-blocks";
import { publicSurface } from "@/lib/release-channel";
import { canonicalSite, docsPageSlugOf } from "@/lib/site";
import {
  codeSpan,
  mdxText,
  operationGroups,
  renderFamilyIndex,
  renderOperation,
  renderOperationPage,
  splitFirstSentence,
  tableCell,
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
  takesIdempotencyKey: false,
  summary: "Create widget",
  group: null,
  description: "Creates a widget. Then it shapes it {once}, with `{braces}` in code.",
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

  it("leads with the endpoint, then the description after its first sentence", () => {
    assert.ok(
      markdown.startsWith(
        '<ApiOperation>\n\n<ApiEndpoint method="POST" path="/v1/widgets/{widgetId}" />\n\nThen it shapes it'
      )
    );
    assert.ok(!markdown.includes("Creates a widget."));
    assert.ok(
      markdown.includes(
        "Requires an [API key](/docs/developing-with-sdp/authentication) with the `wallets.manage` action."
      )
    );
  });

  it("escapes MDX outside code spans only", () => {
    assert.ok(markdown.includes("Then it shapes it \\{once\\}, with `{braces}` in code."));
  });

  it("lists parameters by location with their facts", () => {
    assert.ok(markdown.includes("## Path parameters"));
    assert.ok(
      markdown.includes(
        "- **`widgetId`** · `string` · required · min length 1 · example `wdg_1`\n\n  Widget ID."
      )
    );
    assert.ok(markdown.includes("- **`page`** · `integer` · greater than 0 · default `1`"));
    assert.ok(!markdown.includes("## Headers"));
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

  it("names a single allowed value as what the field always is", () => {
    const [widgetId] = CREATE_WIDGET.parameters;
    assert.ok(widgetId);
    const page = renderOperation({
      ...CREATE_WIDGET,
      parameters: [{ ...widgetId, schema: schema({ enum: ["fixed"] }) }],
    });
    assert.ok(page.includes("- **`widgetId`** · `string` · required · always `fixed`"));
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

  it("sends an Idempotency-Key in the samples only where the route takes one", () => {
    assert.ok(!markdown.includes("Idempotency-Key"));
    const keyed = renderOperation({ ...CREATE_WIDGET, takesIdempotencyKey: true });
    assert.ok(keyed.includes('  -H "Idempotency-Key: $(uuidgen)"'));
    assert.ok(keyed.includes('    "Idempotency-Key": crypto.randomUUID()'));
    assert.ok(keyed.includes('"Idempotency-Key": str(uuid.uuid4())'));
  });
});

describe("the operation's panel", () => {
  const markdown = renderOperation(CREATE_WIDGET);

  it("holds the samples and example responses, after the responses list", () => {
    const panel = markdown.slice(markdown.indexOf("<ApiPanel>"), markdown.indexOf("</ApiPanel>"));
    assert.ok(markdown.indexOf("## Responses") < markdown.indexOf("<ApiPanel>"));
    for (const part of ["## Example request", 'tab="cURL"', "## Example responses", 'tab="404"']) {
      assert.ok(panel.includes(part), part);
    }
    assert.ok(markdown.endsWith("</ApiPanel>\n\n</ApiOperation>"));
  });

  it("unwraps into the Markdown it holds, links and all", () => {
    const expanded = expandDocsBlocks(`${markdown}\n`, "widgets/create-widget.mdx");
    assert.ok(!/<\/?Api(Operation|Panel|Endpoint)/.test(expanded));
    assert.ok(expanded.startsWith("`POST /v1/widgets/{widgetId}`\n\nThen it shapes it"));
    assert.ok(expanded.includes("## Example request\n\n```bash"));
    assert.ok(expanded.includes("[API key](/docs/developing-with-sdp/authentication) with"));
  });
});

describe("renderOperationPage", () => {
  it("titles the page by its summary and describes it by its first sentence", () => {
    assert.ok(
      renderOperationPage(CREATE_WIDGET).startsWith(
        [
          "---",
          "title: Create widget",
          "description: Creates a widget.",
          "icon: method:POST",
          "apiReference: true",
          "---",
          "",
          "<ApiOperation>",
          "",
          '<ApiEndpoint method="POST"',
        ].join("\n")
      )
    );
  });

  it("drops code ticks from the description, which nothing renders as Markdown", () => {
    const page = renderOperationPage({ ...CREATE_WIDGET, description: "Reads `id` values." });
    assert.ok(page.includes("description: Reads id values.\n"));
  });
});

describe("operation groups", () => {
  const widget = (operationId: string, group: string | null): ApiOperation => ({
    ...CREATE_WIDGET,
    operationId,
    endpointId: operationId,
    summary: operationId,
    group,
  });
  const family = (operations: ApiOperation[]) => ({
    name: "Widgets",
    description: "Widget endpoints.",
    operations,
  });

  it("groups a family's operations in the order it first names each group", () => {
    const groups = operationGroups(
      family([widget("a", "Shapes"), widget("b", "Colours"), widget("c", "Shapes")])
    );
    assert.deepEqual(
      groups.map(({ title, operations }) => [title, operations.map((each) => each.operationId)]),
      [
        ["Shapes", ["a", "c"]],
        ["Colours", ["b"]],
      ]
    );
  });

  it("keeps a family flat when it names no group or only one", () => {
    for (const operations of [
      [widget("a", null), widget("b", null)],
      [widget("a", "Shapes"), widget("b", "Shapes")],
    ]) {
      assert.deepEqual(
        operationGroups(family(operations)).map(({ title }) => title),
        [null]
      );
    }
  });

  it("gives each group its heading and table on the family's page", () => {
    const page = renderFamilyIndex(
      family([widget("a", "Shapes"), widget("b", "Colours")]),
      (operation) => `/docs/reference/api/widgets/${operation.endpointId}`
    );
    assert.ok(
      page.includes(
        "## Shapes\n\n<ApiOperationTable>\n\n| Method | Endpoint | Summary |\n| --- | --- | --- |\n| `POST` | `/v1/widgets/{widgetId}` | [a](/docs/reference/api/widgets/a) |\n\n</ApiOperationTable>\n\n## Colours\n\n<ApiOperationTable>"
      )
    );
  });

  it("leaves a group's folder out of its pages' URLs, as Fumadocs does", () => {
    assert.equal(
      docsPageSlugOf("reference/api/payments/(transfers)/list-payment-transfers.mdx"),
      "reference/api/payments/list-payment-transfers"
    );
    assert.equal(
      docsPageSlugOf("reference/api/payments/index.mdx"),
      "reference/api/payments/index"
    );
  });
});

describe("renderFamilyIndex", () => {
  const page = renderFamilyIndex(
    { name: "Widgets", description: "Widget endpoints.", operations: [CREATE_WIDGET] },
    (operation) => `/docs/reference/api/widgets/${operation.endpointId}`
  );

  it("is the family's table, each row linking to its operation's page", () => {
    assert.ok(page.startsWith("---\ntitle: Widgets\ndescription: Widget endpoints.\n---\n"));
    assert.ok(
      page.includes(
        "| `POST` | `/v1/widgets/{widgetId}` | [Create widget](/docs/reference/api/widgets/create-widget) |"
      )
    );
  });

  it("links each row to the operation's Markdown in the Markdown agents get", () => {
    const markdown = expandDocsBlocks(page, "widgets/index.mdx");
    assert.ok(!markdown.includes("ApiOperationTable"));
    assert.ok(
      markdown.includes("| [Create widget](/docs/reference/api/widgets/create-widget.md) |")
    );
  });

  it("fails on a row that links anything but a docs page inline", () => {
    for (const link of ["[x](https://example.com)", "[x](/docs/a#b)", '[x](/docs/a "t")']) {
      const table = `<ApiOperationTable>\n\n| Summary |\n| --- |\n| ${link} |\n\n</ApiOperationTable>\n`;
      assert.throws(() => expandDocsBlocks(table, "t.mdx"), /not a docs page inline/);
    }
  });

  it("keeps a summary's MDX escapes and escapes its pipes", () => {
    const table = renderFamilyIndex(
      {
        name: "Widgets",
        description: "Widget endpoints.",
        operations: [{ ...CREATE_WIDGET, summary: "Read {a} | b" }],
      },
      (operation) => `/docs/reference/api/widgets/${operation.endpointId}`
    );
    assert.ok(
      table.includes("| [Read \\{a\\} \\| b](/docs/reference/api/widgets/create-widget) |")
    );
  });
});

describe("tableCell", () => {
  it("escapes the pipes that would end a cell and only those", () => {
    assert.equal(tableCell("a | b"), "a \\| b");
    assert.equal(tableCell("a \\| b"), "a \\| b");
    assert.equal(tableCell("a \\\\| b"), "a \\\\\\| b");
    assert.equal(tableCell("`x|y`"), "`x\\|y`");
  });
});

describe("splitFirstSentence", () => {
  it("splits at the first sentence end before a capital, a code span or a parenthesis", () => {
    assert.deepEqual(splitFirstSentence("Lists wallets. Use `page` to page."), {
      first: "Lists wallets.",
      rest: "Use `page` to page.",
    });
    assert.deepEqual(splitFirstSentence("Reads v1.2 values. `id` names it."), {
      first: "Reads v1.2 values.",
      rest: "`id` names it.",
    });
    assert.deepEqual(splitFirstSentence("One sentence only."), {
      first: "One sentence only.",
      rest: null,
    });
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
    const body = page.replace(/^---[\s\S]*?---\n/, "");
    const processor = unified()
      .use(remarkParse)
      .use(remarkMdx)
      .use(remarkDocsBlocks, { surface: publicSurface });
    const tree = processor.parse(body);
    processor.runSync(tree);
    const [element] = tree.children;
    assert.equal(element?.type, "mdxJsxFlowElement");
    const search = structure(body, [remarkMdx, [remarkDocsBlocks, { surface: publicSurface }]]);
    assert.deepEqual(
      search.contents.map(({ content }) => content),
      ["GET /v1/widgets/{widgetId}"]
    );
  });

  it("refuses a method the API does not use", () => {
    assert.throws(() =>
      expandDocsBlocks('<ApiEndpoint method="TRACE" path="/health" />\n', "bad.mdx")
    );
  });
});

describe("fact separators", () => {
  const facts = "- **`page`** · `integer` · greater than 0\n";
  const compiled = (path: string) => {
    const processor = unified()
      .use(remarkParse)
      .use(remarkMdx)
      .use(remarkDocsBlocks, { surface: publicSurface });
    return JSON.stringify(processor.runSync(processor.parse(facts), { path }));
  };

  it("sets each dot apart on a generated reference page, and only there", () => {
    const page = compiled("/repo/apps/sdp-docs/content/docs/reference/api/widgets/list.mdx");
    assert.equal(page.match(/launch-api-separator/g)?.length, 2);
    const guide = compiled("/repo/apps/sdp-docs/content/docs/guides/widgets.mdx");
    assert.ok(!guide.includes("launch-api-separator"));
  });

  it("keeps the dots as text in the Markdown agents get", () => {
    assert.equal(expandDocsBlocks(facts, "content/docs/reference/api/widgets/list.mdx"), facts);
  });
});

describe("the samples' API", () => {
  const page = renderOperation(CREATE_WIDGET);
  const deploymentApi = "https://api.stage.example";
  const compiled = (path: string) => {
    const tree = unified().use(remarkParse).use(remarkMdx).parse(page);
    remarkDocsBlocks({ surface: publicSurface, apiUrl: deploymentApi })(tree, { path });
    return JSON.stringify(tree);
  };

  it("is this deployment's on a generated reference page, and only there", () => {
    const reference = compiled("/repo/apps/sdp-docs/content/docs/reference/api/widgets/create.mdx");
    assert.ok(reference.includes(`${deploymentApi}/v1/widgets/wdg_1`));
    assert.ok(!reference.includes(canonicalSite.apiUrl));
    const guide = compiled("/repo/apps/sdp-docs/content/docs/guides/widgets.mdx");
    assert.ok(guide.includes(`${canonicalSite.apiUrl}/v1/widgets/wdg_1`));
  });

  it("stays canonical in the Markdown agents and the llms files get", () => {
    const markdown = expandDocsBlocks(`${page}\n`, "content/docs/reference/api/widgets/create.mdx");
    assert.ok(markdown.includes(`${canonicalSite.apiUrl}/v1/widgets/wdg_1`));
  });
});

describe("<ActionLinks>", () => {
  it("is its links alone in the Markdown agents get", () => {
    const links = [
      '<a href="/docs/postman/collection.json" download>Download Postman collection</a>',
      '<a href="/docs/postman/collection.json">Open raw JSON</a>',
    ];
    const page = `<ActionLinks>\n  ${links[0]}\n  ${links[1]}\n</ActionLinks>\n`;
    assert.equal(expandDocsBlocks(page, "postman-collection.mdx"), `${links[0]}\n  ${links[1]}\n`);
  });
});

describe("stripMdxEsm", () => {
  it("drops the page's imports and keeps an import inside a code fence", () => {
    const page = [
      'import { Tab } from "fumadocs-ui/components/tabs";',
      "",
      "Call it:",
      "",
      '```python tab="Python"',
      "import os, requests",
      "",
      'r = requests.get("https://api.solana.com/health")',
      "```",
      "",
    ].join("\n");
    const markdown = stripMdxEsm(page, "page.mdx");
    assert.ok(!markdown.includes("fumadocs-ui"));
    assert.ok(markdown.includes("import os, requests\n\nr = requests.get"));
  });
});
