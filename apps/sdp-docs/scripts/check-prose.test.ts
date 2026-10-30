import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { inspectProse } from "./check-prose";

describe("prose checks", () => {
  it("parses description metadata and rejects invalid YAML field types", () => {
    assert.deepEqual(inspectProse('---\ntitle: Example\ndescription: "Short intro."\n---\n'), []);
    assert.deepEqual(inspectProse("---\n\n---\n"), []);
    assert.throws(() => inspectProse("---\ndescription: 42\n---\n"), /expected string/);
    assert.throws(() => inspectProse("---\n- description\n---\n"), /expected object/);
    assert.throws(() => inspectProse("---\nnull\n---\n"), /expected object/);
    assert.throws(() => inspectProse("---\n \n---\n"), /expected object/);
  });

  it("counts Unicode characters rather than UTF-16 units in descriptions", () => {
    assert.deepEqual(inspectProse(`---\ndescription: "${"🌞".repeat(130)}"\n---\n`), []);
    assert.deepEqual(inspectProse(`---\ndescription: "${"🌞".repeat(131)}"\n---\n`), [
      { line: 1, message: "description has 131 characters (max 130)" },
    ]);
  });

  it("checks paragraphs with source line numbers while ignoring code", () => {
    const words = Array.from({ length: 81 }, () => "word").join(" ");
    const source = `---\ntitle: Example\n---\n\n${words}\n\n\`\`\`text\n${words}\n\`\`\`\n`;
    assert.deepEqual(inspectProse(source), [
      { line: 5, message: "paragraph has 81 words (max 80)" },
    ]);
  });
});
