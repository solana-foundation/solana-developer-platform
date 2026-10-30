import assert from "node:assert/strict";
import test from "node:test";
import { FIELDS, isFieldVisible, SECTIONS } from "./fields";
import { defaultValues } from "./generate";
import type { SectionId } from "./types";

test("no duplicate field keys", () => {
  const keys = FIELDS.map((f) => f.key);
  assert.equal(new Set(keys).size, keys.length);
});

test("every field references a declared section", () => {
  const ids = new Set<SectionId>(SECTIONS.map((s) => s.id));
  for (const f of FIELDS) assert.ok(ids.has(f.section), `unknown section: ${f.section}`);
});

test("every select/multiselect field has static or dynamic options", () => {
  for (const f of FIELDS.filter((f) => f.kind === "select" || f.kind === "multiselect")) {
    const hasStatic = Boolean(f.options && f.options.length > 0);
    assert.ok(hasStatic || f.optionsWhen, `${f.key} missing options`);
  }
});

test("every select field's default value is one of its (resolved) options", () => {
  const base = defaultValues();
  for (const f of FIELDS.filter((f) => f.kind === "select")) {
    if (f.defaultValue === undefined) continue;
    const opts = f.optionsWhen ? f.optionsWhen(base) : f.options;
    const values = opts?.map((o) => o.value) ?? [];
    assert.ok(values.includes(f.defaultValue), `${f.key} default ${f.defaultValue} not in options`);
  }
});

test("multiselect default values are a subset of options", () => {
  const base = defaultValues();
  for (const f of FIELDS.filter((f) => f.kind === "multiselect")) {
    const opts = (f.optionsWhen ? f.optionsWhen(base) : f.options) ?? [];
    const allowed = new Set(opts.map((o) => o.value));
    for (const v of (f.defaultValue ?? "").split(",").filter(Boolean)) {
      assert.ok(allowed.has(v), `${f.key} default ${v} not in options`);
    }
  }
});

test("Kora mainnet fields show only once a mainnet RPC endpoint is set", () => {
  const koraMainnetFields = FIELDS.filter((f) => f.key.startsWith("KORA_MAINNET_"));
  const kora = { ...defaultValues(), FEE_PAYMENT_PROVIDER: "kora" };
  const withMainnetRpc = {
    ...kora,
    SOLANA_RPC_DEFAULT_MAINNET_API_KEY_URL: "https://mainnet.rpc.example.test",
  };

  assert.deepEqual(
    koraMainnetFields.map((f) => isFieldVisible(f, kora)),
    [false, false]
  );
  assert.deepEqual(
    koraMainnetFields.map((f) => isFieldVisible(f, withMainnetRpc)),
    [true, true]
  );
});
