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
  const hex = value.toString(16);
  // Upstream's native binding throws when the value does not fit rather than
  // wrapping; the truncating slice this replaces is exactly the silent
  // overflow an amount encoding must never produce, so this copy refuses it
  // too.
  if (hex.length > width * 2) {
    throw new RangeError(`Expected a bigint that fits in ${width} bytes`);
  }
  return Buffer.from(hex.padStart(width * 2, "0"), "hex");
}

module.exports = { toBigIntBE, toBigIntLE, toBufferBE, toBufferLE };
