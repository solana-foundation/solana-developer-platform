function asBuffer(value) {
  if (!Buffer.isBuffer(value) && !(value instanceof Uint8Array)) {
    throw new TypeError("Expected a Buffer or Uint8Array");
  }
  return Buffer.from(value);
}

function assertBigInt(value) {
  if (typeof value !== "bigint") {
    throw new TypeError("Expected a bigint");
  }
  if (value < 0n) {
    throw new RangeError("Expected a non-negative bigint");
  }
}

function assertWidth(width) {
  if (!Number.isSafeInteger(width) || width < 0) {
    throw new RangeError("Expected width to be a non-negative safe integer");
  }
}

function toBigIntLE(value) {
  const buffer = asBuffer(value);
  buffer.reverse();
  const hex = buffer.toString("hex");
  return hex.length === 0 ? 0n : BigInt(`0x${hex}`);
}

function toBigIntBE(value) {
  const hex = asBuffer(value).toString("hex");
  return hex.length === 0 ? 0n : BigInt(`0x${hex}`);
}

function toBufferLE(value, width) {
  const buffer = toBufferBE(value, width);
  buffer.reverse();
  return buffer;
}

function toBufferBE(value, width) {
  assertBigInt(value);
  assertWidth(width);
  // Fail closed the way the native binding does: a value wider than `width`
  // must throw, never encode as a different, smaller amount. The npm
  // package's pure-JS fallback truncates (`hex.slice(0, width * 2)`), and
  // this compatibility package exists precisely because that package's
  // native loader is unsafe, so the fallback is the only path that ever
  // runs here.
  if (value >> BigInt(width * 8) !== 0n) {
    throw new RangeError("BigInt is too large to fit in the requested width");
  }
  // A zero value has no hex digits; `padStart` alone sizes the field.
  const hex = value === 0n ? "" : value.toString(16);
  return Buffer.from(hex.padStart(width * 2, "0"), "hex");
}

module.exports = { toBigIntBE, toBigIntLE, toBufferBE, toBufferLE };
