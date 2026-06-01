import assert from "node:assert/strict";
import test from "node:test";
import { defaultValues } from "./generate";
import { validateValues } from "./validate";

test("required visible field with empty value reports an error", () => {
  const errors = validateValues({ ...defaultValues(), CLERK_SECRET_KEY: "" });
  assert.ok(errors.CLERK_SECRET_KEY);
});

test("pattern mismatch reports an error", () => {
  const errors = validateValues({ ...defaultValues(), CLERK_SECRET_KEY: "nope" });
  assert.ok(errors.CLERK_SECRET_KEY);
});

test("valid value has no error", () => {
  const errors = validateValues({ ...defaultValues(), CLERK_SECRET_KEY: "sk_live_abc" });
  assert.equal(errors.CLERK_SECRET_KEY, undefined);
});

test("invisible required field is not validated", () => {
  // POSTGRES_PASSWORD is required but hidden when DATABASE_MODE=external
  const errors = validateValues({
    ...defaultValues(),
    DATABASE_MODE: "external",
    POSTGRES_PASSWORD: "",
  });
  assert.equal(errors.POSTGRES_PASSWORD, undefined);
});
