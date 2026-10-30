const assert = require("node:assert/strict");
const test = require("node:test");
const { toBigIntBE, toBigIntLE, toBufferBE, toBufferLE } = require("../node.js");

test("converts valid buffers without native bindings", () => {
  assert.equal(toBigIntBE(Buffer.from("deadbeef", "hex")), 0xdeadbeefn);
  assert.equal(toBigIntLE(Buffer.from("deadbeef", "hex")), 0xefbeadden);
  assert.deepEqual(toBufferBE(0xdeadbeefn, 8), Buffer.from("00000000deadbeef", "hex"));
  assert.deepEqual(toBufferLE(0xdeadbeefn, 8), Buffer.from("efbeadde00000000", "hex"));
  assert.equal(toBigIntBE(Buffer.alloc(0)), 0n);
  assert.equal(toBigIntLE(Buffer.alloc(0)), 0n);
});

test("rejects the invalid inputs that reach the vulnerable native boundary", () => {
  for (const value of [null, undefined, {}, "deadbeef"]) {
    assert.throws(() => toBigIntLE(value), TypeError);
    assert.throws(() => toBigIntBE(value), TypeError);
  }
});

test("rejects invalid output sizes and signed values", () => {
  assert.throws(() => toBufferBE(-1n, 8), RangeError);
  assert.throws(() => toBufferLE(1n, -1), RangeError);
  assert.throws(() => toBufferBE(1n, 1.5), RangeError);
});

// A value wider than the target must fail loudly. The historic behavior took
// the most-significant `width` bytes of the padded hex, silently wrapping an
// over-wide amount to a smaller number — the one error an amount encoder must
// never survive quietly.
test("rejects an over-wide bigint instead of truncating it", () => {
  assert.throws(() => toBufferBE(0x1_0000_0000_0000_0000n, 8), RangeError);
  assert.throws(() => toBufferLE(0x1_0000_0000_0000_0000n, 8), RangeError);
  assert.throws(() => toBufferBE(256n, 1), RangeError);
  assert.throws(() => toBufferBE(1n, 0), RangeError);
  assert.throws(
    () => toBufferBE(0x1_0000_0000_dead_beefn, 8),
    (error) => error instanceof RangeError && /8 byte/.test(error.message)
  );
});

test("still encodes values that fit, zero included", () => {
  assert.deepEqual(toBufferBE(0n, 0), Buffer.alloc(0));
  assert.deepEqual(toBufferLE(0n, 0), Buffer.alloc(0));
  assert.deepEqual(toBufferBE(0n, 8), Buffer.alloc(8));
  assert.deepEqual(toBufferBE(0xffffn, 2), Buffer.from("ffff", "hex"));
});
