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

test("throws instead of wrapping when the value overflows the width", () => {
  // A silent wrap encodes 2^64 as zero, so an oversized amount must refuse to
  // encode at all — matching the native binding's contract.
  assert.throws(() => toBufferBE(2n ** 64n, 8), RangeError);
  assert.throws(() => toBufferLE(2n ** 64n, 8), RangeError);
  assert.throws(() => toBufferBE(2n ** 128n, 16), RangeError);
  // The boundary itself still encodes.
  assert.deepEqual(toBufferBE(2n ** 64n - 1n, 8), Buffer.from("ffffffffffffffff", "hex"));
  assert.deepEqual(toBufferLE(2n ** 64n - 1n, 8), Buffer.from("ffffffffffffffff", "hex"));
});
