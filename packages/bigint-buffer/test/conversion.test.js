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

test("rejects values wider than the requested width instead of truncating", () => {
  // A silent truncation encodes a different (smaller) amount than the caller
  // asked for — u64/u128 token-amount layouts encode through this function,
  // so a too-large value must fail, the way the npm package's native binding
  // does, rather than quietly shift the top bytes into place.
  assert.throws(() => toBufferBE(1n << 64n, 8), RangeError);
  assert.throws(() => toBufferBE((1n << 80n) | 1n, 8), RangeError);
  assert.throws(() => toBufferLE(1n << 64n, 8), RangeError);
  // Boundary values still encode exactly.
  assert.deepEqual(toBufferBE((1n << 64n) - 1n, 8), Buffer.from("ffffffffffffffff", "hex"));
  assert.deepEqual(toBufferLE((1n << 64n) - 1n, 8), Buffer.from("ffffffffffffffff", "hex"));
  assert.deepEqual(toBufferLE(0xdeadbeefn, 8), Buffer.from("efbeadde00000000", "hex"));
});

test("round-trips values through both endiannesses", () => {
  for (const value of [0n, 1n, 255n, 256n, 0xdeadbeefn, (1n << 64n) - 1n, (1n << 128n) - 1n]) {
    assert.equal(toBigIntBE(toBufferBE(value, 16)), value);
    assert.equal(toBigIntLE(toBufferLE(value, 16)), value);
  }
});

test("a zero-width field holds only zero", () => {
  assert.deepEqual(toBufferBE(0n, 0), Buffer.alloc(0));
  assert.deepEqual(toBufferLE(0n, 0), Buffer.alloc(0));
  assert.throws(() => toBufferBE(1n, 0), RangeError);
  assert.throws(() => toBufferLE(1n, 0), RangeError);
});
