import { describe, expect, it } from "vitest";
import { buildSnippets } from "./api-playground-snippets";

const URL = "https://api-dev.solana.com/v1/wallets";

describe("buildSnippets", () => {
  it("writes a read as a bare curl, fetch and requests call with the key from the environment", () => {
    const { curl, ts, py } = buildSnippets({ method: "GET", url: URL, body: null });
    expect(curl).toBe(`curl ${URL} \\\n  -H "Authorization: Bearer $SDP_API_KEY"`);
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
    const { curl, ts, py } = buildSnippets({ method: "POST", url: URL, body });
    expect(curl).toContain(`curl -X POST ${URL} \\`);
    expect(curl).toContain('  -H "Content-Type: application/json" \\');
    expect(curl).toContain(`  -d '{\n    "label": "Ops",`);
    expect(ts).toContain("  body: JSON.stringify({");
    expect(py).toContain('"active": True');
    expect(py).toContain('"cap": None');
    expect(py.endsWith("})")).toBe(true);
  });

  it("keeps a single quote in the body from ending curl's shell string", () => {
    const { curl } = buildSnippets({ method: "POST", url: URL, body: { label: "Ana's wallet" } });
    expect(curl).toContain(`"label": "Ana'\\''s wallet"`);
  });
});
