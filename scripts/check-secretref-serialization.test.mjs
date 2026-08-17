import assert from "node:assert/strict";
import test from "node:test";
import { findSecretRefViolations } from "./check-secretref-serialization.mjs";

test("flags a revealed secret passed to JSON.stringify", () => {
  const violations = findSecretRefViolations(
    `const payload = JSON.stringify({ key: keyRef.material.reveal("adapter") });\n`,
    "apps/sdp-api/src/services/helius-rings/example.ts"
  );

  assert.equal(violations.length, 1);
  assert.match(violations[0], /^apps\/sdp-api\/src\/services\/helius-rings\/example\.ts:1: /);
  assert.match(violations[0], /JSON\.stringify\(\) receives a revealed SecretRef/);
});

test("flags a revealed secret passed to a logger", () => {
  const violations = findSecretRefViolations(
    `getLogger().info({ viewingKey: keys.viewing.reveal("adapter") }, "provisioned");\n`,
    "apps/sdp-api/src/services/helius-rings/example.ts"
  );

  assert.equal(violations.length, 1);
  assert.match(violations[0], /info\(\) receives a revealed SecretRef/);
});

test("flags a revealed secret interpolated into a template literal", () => {
  const violations = findSecretRefViolations(
    `const message = \`viewing key is \${secret.reveal("signer")}\`;\n`,
    "packages/sdp-helius-rings/src/example.ts"
  );

  assert.equal(violations.length, 1);
  assert.match(violations[0], /Template literal interpolates a revealed SecretRef/);
});

test("flags a revealed secret coerced with String()", () => {
  const violations = findSecretRefViolations(
    `const asText = String(secret.reveal("adapter"));\n`,
    "packages/sdp-helius-rings/src/example.ts"
  );

  assert.equal(violations.length, 1);
  assert.match(violations[0], /String\(\) receives a revealed SecretRef/);
});

test("flags stringifying a SecretRef as pointless rather than dangerous", () => {
  const violations = findSecretRefViolations(
    `const encoded = JSON.stringify(new SecretRef("hunter2"));\n`,
    "packages/sdp-helius-rings/src/example.ts"
  );

  assert.equal(violations.length, 1);
  assert.match(violations[0], /carries no information/);
});

test("finds a reveal nested deep inside a log argument", () => {
  const violations = findSecretRefViolations(
    `logger.error({ op: { detail: { material: ref.material.reveal("signer") } } }, "failed");\n`,
    "apps/sdp-api/src/services/helius-rings/example.ts"
  );

  assert.equal(violations.length, 1);
  assert.match(violations[0], /error\(\) receives a revealed SecretRef/);
});

test("reports each offending call once, with its own line", () => {
  const violations = findSecretRefViolations(
    [
      `logger.info({ a: s.reveal("adapter") }, "one");`,
      `const t = \`\${s.reveal("adapter")}\`;`,
    ].join("\n"),
    "apps/sdp-api/src/example.ts"
  );

  assert.equal(violations.length, 2);
  assert.match(violations[0], /:1: /);
  assert.match(violations[1], /:2: /);
});

test("allows passing the wrapper itself to a logger or serializer", () => {
  const violations = findSecretRefViolations(
    [
      `getLogger().info({ proof: operation.proof }, "prepared");`,
      `const body = JSON.stringify({ ref: operation.proof.ref });`,
      `const shown = \`proof \${operation.proof.ref}\`;`,
    ].join("\n"),
    "apps/sdp-api/src/services/helius-rings/example.ts"
  );

  assert.deepEqual(violations, []);
});

test("allows reveal() where it belongs — handed to an adapter or signer", () => {
  const violations = findSecretRefViolations(
    [
      `await gateway.buildOperation({ material: keyRef.material.reveal("adapter") });`,
      `const signature = await signer.sign(payload, key.reveal("signer"));`,
    ].join("\n"),
    "apps/sdp-api/src/services/helius-rings/example.ts"
  );

  assert.deepEqual(violations, []);
});

test("flags a revealed secret logged through a variable", () => {
  const violations = findSecretRefViolations(
    [
      `const material = keyRef.material.reveal("adapter");`,
      `logger.info({ material }, "provisioned");`,
    ].join("\n"),
    "apps/sdp-api/src/services/helius-rings/example.ts"
  );

  assert.equal(violations.length, 1);
  assert.match(violations[0], /:2: info\(\) receives a revealed SecretRef/);
});

test("follows an alias chain and reassignment to a sink", () => {
  const violations = findSecretRefViolations(
    [
      `let value = other;`,
      `value = secret.reveal("signer");`,
      `const copy = value;`,
      `const body = JSON.stringify({ copy });`,
      `const shown = \`key \${copy}\`;`,
    ].join("\n"),
    "apps/sdp-api/src/services/helius-rings/example.ts"
  );

  assert.equal(violations.length, 2);
  assert.match(violations[0], /:4: JSON\.stringify\(\) receives a revealed SecretRef/);
  assert.match(violations[1], /:5: Template literal interpolates a revealed SecretRef/);
});

test("does not taint values transformed by another call", () => {
  const violations = findSecretRefViolations(
    [
      `const digest = sha256(secret.reveal("adapter"));`,
      `logger.info({ digest }, "provisioned");`,
    ].join("\n"),
    "apps/sdp-api/src/services/helius-rings/example.ts"
  );

  // Hashing is the sanctioned way to log; only direct aliases are tracked.
  assert.deepEqual(violations, []);
});

test("does not flag a same-named property on another object", () => {
  const violations = findSecretRefViolations(
    [
      `const material = keyRef.material.reveal("adapter");`,
      `await gateway.buildOperation({ material });`,
      `logger.info({ kind: row.material }, "stored");`,
    ].join("\n"),
    "apps/sdp-api/src/services/helius-rings/example.ts"
  );

  assert.deepEqual(violations, []);
});

test("does not confuse an unrelated reveal() method", () => {
  const violations = findSecretRefViolations(
    `logger.info({ state: animation.reveal() }, "toggled");\n`,
    "apps/sdp-web/src/example.ts"
  );

  // A false positive here is acceptable and deliberate: the check is
  // name-based, and `reveal()` is rare enough outside SecretRef that catching
  // the leak is worth the occasional rename. Documented so the behaviour is a
  // decision rather than a surprise.
  assert.equal(violations.length, 1);
});
