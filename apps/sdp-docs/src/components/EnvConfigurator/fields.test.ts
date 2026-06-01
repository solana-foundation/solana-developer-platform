import assert from "node:assert/strict";
import test from "node:test";
import { FIELDS, SECTIONS } from "./fields";
import type { SectionId } from "./types";

test("no duplicate field keys", () => {
  const keys = FIELDS.map((f) => f.key);
  assert.equal(new Set(keys).size, keys.length);
});

test("every field references a declared section", () => {
  const ids = new Set<SectionId>(SECTIONS.map((s) => s.id));
  for (const f of FIELDS) assert.ok(ids.has(f.section), `unknown section: ${f.section}`);
});

test("every select field has options", () => {
  for (const f of FIELDS.filter((f) => f.kind === "select")) {
    assert.ok(f.options && f.options.length > 0, `${f.key} missing options`);
  }
});

test("every select field's default value is one of its options", () => {
  for (const f of FIELDS.filter((f) => f.kind === "select")) {
    if (f.defaultValue === undefined) continue;
    const values = f.options?.map((o) => o.value) ?? [];
    assert.ok(values.includes(f.defaultValue), `${f.key} default ${f.defaultValue} not in options`);
  }
});
