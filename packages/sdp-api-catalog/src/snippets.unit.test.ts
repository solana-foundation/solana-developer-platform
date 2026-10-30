import { describe, expect, it } from "vitest";
import { buildSnippets, type SnippetRequest } from "./snippets";

const URL = "https://api-dev.solana.com/v1/wallets";

/** A read with the API key; each test overrides what it exercises. */
const READ: SnippetRequest = {
  method: "GET",
  url: URL,
  body: null,
  auth: "apiKey",
  takesIdempotencyKey: false,
};

describe("buildSnippets", () => {
  it("writes a read as a bare curl, fetch and requests call with the key from the environment", () => {
    const { curl, ts, py } = buildSnippets(READ);
    expect(curl).toBe(`curl '${URL}' \\\n  -H "Authorization: Bearer $SDP_API_KEY"`);
    expect(ts).toContain(`const res = await fetch("${URL}", {`);
    // biome-ignore lint/suspicious/noTemplateCurlyInString: the snippet holds a template literal.
    expect(ts).toContain("Authorization: `Bearer ${process.env.SDP_API_KEY}`");
    expect(ts).not.toContain("body:");
    expect(py).toBe(
      `import os, requests\n\nr = requests.get("${URL}",\n  headers={"Authorization": f"Bearer {os.environ['SDP_API_KEY']}"})`
    );
  });

  it("sends a body as JSON in each language, with Python's own literals", () => {
    const body = { label: "Ops", purpose: "root", active: true, cap: null };
    const { curl, ts, py } = buildSnippets({ ...READ, method: "POST", body });
    expect(curl).toContain(`curl -X POST '${URL}' \\`);
    expect(curl).toContain('  -H "Content-Type: application/json" \\');
    expect(curl).toContain(`  -d '{\n    "label": "Ops",`);
    expect(ts).toContain("  body: JSON.stringify({");
    expect(py).toContain('"active": True');
    expect(py).toContain('"cap": None');
    expect(py.endsWith("})")).toBe(true);
  });

  it("gives a call its own Idempotency-Key in each language where the route takes one", () => {
    for (const method of ["POST", "PATCH", "DELETE"]) {
      const { curl, ts, py } = buildSnippets({ ...READ, method, takesIdempotencyKey: true });
      expect(curl).toBe(
        `curl -X ${method} '${URL}' \\\n  -H "Authorization: Bearer $SDP_API_KEY" \\\n  -H "Idempotency-Key: $(uuidgen)"`
      );
      expect(ts).toContain('    "Idempotency-Key": crypto.randomUUID()');
      expect(py.startsWith("import os, requests, uuid\n")).toBe(true);
      expect(py).toContain('"Idempotency-Key": str(uuid.uuid4())');
    }
    const write = buildSnippets({
      ...READ,
      method: "POST",
      body: { label: "Ops" },
      takesIdempotencyKey: true,
    });
    expect(write.curl).toContain(
      '  -H "Idempotency-Key: $(uuidgen)" \\\n  -H "Content-Type: application/json" \\'
    );
  });

  it("sends no Idempotency-Key where the route takes none, a write included", () => {
    for (const method of ["GET", "POST", "PATCH", "DELETE"]) {
      const { curl, ts, py } = buildSnippets({ ...READ, method, body: { label: "Ops" } });
      expect(`${curl}${ts}${py}`).not.toMatch(/Idempotency-Key|uuid/);
    }
  });

  it("keeps a single quote in the body from ending curl's shell string", () => {
    const { curl } = buildSnippets({ ...READ, method: "POST", body: { label: "Ana's wallet" } });
    expect(curl).toContain(`"label": "Ana'\\''s wallet"`);
  });

  it("quotes the URL so a query string's & does not end the curl command", () => {
    const url = `${URL}/transfers?status=confirmed&pageSize=25`;
    const { curl } = buildSnippets({ ...READ, url });
    expect(curl.split("\n")[0]).toBe(`curl '${url}' \\`);
  });

  it("leaves the key out of a public route's call in each language", () => {
    const url = "https://api-dev.solana.com/health";
    const { curl, ts, py } = buildSnippets({ ...READ, url, auth: "none" });
    expect(curl).toBe(`curl '${url}'`);
    expect(ts).toBe(`const res = await fetch("${url}", {\n  method: "GET"\n});`);
    expect(py).toBe(`import requests\n\nr = requests.get("${url}")`);
  });

  it("keeps a public route's Idempotency-Key and body without the API key", () => {
    const { curl, py } = buildSnippets({
      ...READ,
      method: "POST",
      body: { a: 1 },
      auth: "none",
      takesIdempotencyKey: true,
    });
    expect(curl).not.toContain("Authorization");
    expect(curl).toContain(
      '  -H "Idempotency-Key: $(uuidgen)" \\\n  -H "Content-Type: application/json"'
    );
    expect(py.startsWith("import requests, uuid\n")).toBe(true);
  });
});
