import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { after, before, describe, it } from "node:test";
import { CodeBlockTabsList, CodeBlockTabsTrigger } from "fumadocs-ui/components/codeblock";
import { createElement as h, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";

let components: typeof import("@/components/docs-shell/code-example");
let styles: ReturnType<typeof registerHooks>;

before(async () => {
  // Rendering checks structure and behavior; the browser verifies actual CSS separately.
  styles = registerHooks({
    load(url, context, nextLoad) {
      if (url.endsWith(".module.css")) {
        return {
          format: "module",
          source: "export default new Proxy({}, { get: (_target, key) => String(key) });",
          shortCircuit: true,
        };
      }
      return nextLoad(url, context);
    },
  });
  components = await import("@/components/docs-shell/code-example");
});

after(() => styles.deregister());

function code(language: string, body: string, title?: string) {
  return h(components.CodeExample, { "data-language": language, title }, h("code", null, body));
}

function copyCount(html: string): number {
  return html.match(/aria-label="Copy code"/g)?.length ?? 0;
}

function ServerCode(props: { "data-language": string; className: string; children?: ReactNode }) {
  return h(components.CodeExample, props);
}

describe("shared docs code examples", () => {
  it("gives a standalone highlighted block one language header and copy control", () => {
    const html = renderToStaticMarkup(code("ts", 'const amount = "25";', "backend.ts"));
    assert.match(html, /TypeScript/);
    assert.match(html, /backend\.ts/);
    assert.match(html, /const amount = &quot;25&quot;;/);
    assert.equal(copyCount(html), 1);
    assert.doesNotMatch(html, /Copy Text/);
  });

  it("turns generated request languages into one dropdown shell with all variants mounted", () => {
    const html = renderToStaticMarkup(
      h(
        components.DocsCodeBlockTabs,
        { defaultValue: "cURL" },
        h(
          CodeBlockTabsList,
          null,
          h(CodeBlockTabsTrigger, { value: "cURL" }, "cURL"),
          h(CodeBlockTabsTrigger, { value: "TypeScript" }, "TypeScript")
        ),
        h(components.DocsCodeBlockTab, { value: "cURL" }, code("bash", "curl example")),
        h(components.DocsCodeBlockTab, { value: "TypeScript" }, code("ts", "await fetch(example)"))
      )
    );
    assert.match(html, /aria-label="Code language: cURL"/);
    assert.equal(copyCount(html), 1);
    assert.match(html, /curl example/);
    assert.match(html, /await fetch\(example\)/);
    assert.equal(html.match(/data-code-example=""/g)?.length, 3);
  });

  it("keeps response status choices instead of relabeling them as languages", () => {
    const html = renderToStaticMarkup(
      h(
        components.DocsCodeBlockTabs,
        { defaultValue: "200" },
        h(
          CodeBlockTabsList,
          null,
          h(CodeBlockTabsTrigger, { value: "200" }, "200"),
          h(CodeBlockTabsTrigger, { value: "400" }, "400")
        ),
        h(components.DocsCodeBlockTab, { value: "200" }, code("json", '{"ok":true}')),
        h(components.DocsCodeBlockTab, { value: "400" }, code("json", '{"error":"invalid"}'))
      )
    );
    assert.doesNotMatch(html, /Code language:/);
    assert.match(html, />200<\/button>/);
    assert.match(html, />400<\/button>/);
    assert.equal(copyCount(html), 2);
    assert.match(html, /data-state="inactive"/);
    assert.match(html, /&quot;error&quot;:&quot;invalid&quot;/);
  });

  it("uses the same shell for authored languages but leaves workflow tabs alone", () => {
    const language = renderToStaticMarkup(
      h(
        components.DocsTabs,
        { items: ["cURL", "TypeScript"] },
        h(components.DocsTab, { value: "cURL" }, code("bash", "curl example")),
        h(components.DocsTab, { value: "TypeScript" }, code("ts", "await fetch(example)"))
      )
    );
    assert.match(language, /Code language: cURL/);
    assert.equal(copyCount(language), 1);
    const workflow = renderToStaticMarkup(
      h(
        components.DocsTabs,
        { items: ["Preview", "Build", "Sign", "Submit"] },
        ...["Preview", "Build", "Sign", "Submit"].map((value) =>
          h(components.DocsTab, { key: value, value }, h("p", null, value))
        )
      )
    );
    assert.doesNotMatch(workflow, /Code language:/);
    assert.match(workflow, />Preview<\/button>/);
    assert.match(workflow, />Submit<\/button>/);
  });

  it("recognizes highlighted code across the server component boundary", () => {
    const html = renderToStaticMarkup(
      h(
        components.DocsTabs,
        { items: ["TypeScript"] },
        h(
          components.DocsTab,
          { value: "TypeScript" },
          h(
            ServerCode,
            { "data-language": "ts", className: "shiki shiki-themes" },
            h("code", null, "await deposit()")
          )
        )
      )
    );
    assert.equal(copyCount(html), 1);
    assert.doesNotMatch(html, /Code language:/);
    assert.match(html, /await deposit\(\)/);
  });

  it("retains per-block copy when a language panel has prose or multiple blocks", () => {
    const html = renderToStaticMarkup(
      h(
        components.DocsTabs,
        { items: ["cURL", "TypeScript"] },
        h(
          components.DocsTab,
          { value: "cURL" },
          h("p", null, "Run both requests."),
          code("bash", "curl first"),
          code("bash", "curl second")
        ),
        h(
          components.DocsTab,
          { value: "TypeScript" },
          code("ts", "await first()"),
          code("ts", "await second()")
        )
      )
    );
    assert.match(html, /Code language: cURL/);
    assert.equal(copyCount(html), 4);
    for (const body of ["curl first", "curl second", "await first()", "await second()"]) {
      assert.ok(html.includes(body));
    }
  });
});
