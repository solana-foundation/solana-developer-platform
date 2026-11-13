// The Anchor IDL account of a program, as `anchor idl init` writes it and Solana Explorer reads it.
// Its address is `createWithSeed(findProgramAddress([], program), "anchor:idl", program)`. Its data
// is the account discriminator, the authority, then the zlib-compressed IDL with a `u32` length. A
// placed IDL has no authority, so the field is zero.

import { createHash } from "node:crypto";
import { deflateSync } from "node:zlib";

import { base58, fromBase58 } from "../e2e/surfnet.mjs";

const P = 2n ** 255n - 19n;
const D = (P - ((121665n * power(121666n, P - 2n)) % P)) % P;
const DISCRIMINATOR = sha256("account:IdlAccount").subarray(0, 8);

export function idlAccount(program, idl) {
  const programBytes = fromBase58(program);
  const base = findProgramAddress([], programBytes);
  const compressed = deflateSync(Buffer.from(JSON.stringify(idl)));
  const length = Buffer.alloc(4);
  length.writeUInt32LE(compressed.length);

  return {
    address: base58(sha256(base, "anchor:idl", programBytes)),
    data: Buffer.concat([DISCRIMINATOR, Buffer.alloc(32), length, compressed]),
  };
}

function findProgramAddress(seeds, program) {
  for (let bump = 255; bump >= 0; bump -= 1) {
    const candidate = sha256(...seeds, Buffer.from([bump]), program, "ProgramDerivedAddress");

    if (!onCurve(candidate)) return candidate;
  }

  throw new Error("no program address is off the curve");
}

// A point decompresses when (y² - 1) / (d·y² + 1) is a square, as in `curve25519-dalek`.
function onCurve(bytes) {
  const y = BigInt(`0x${Buffer.from(bytes).reverse().toString("hex")}`) & ((1n << 255n) - 1n);
  const ySquared = (y * y) % P;
  const xSquared = (((ySquared - 1n + P) % P) * power((D * ySquared + 1n) % P, P - 2n)) % P;

  return xSquared === 0n || power(xSquared, (P - 1n) / 2n) === 1n;
}

function power(base, exponent) {
  let result = 1n;

  for (let b = base % P, e = exponent; e > 0n; b = (b * b) % P, e >>= 1n) {
    if (e & 1n) result = (result * b) % P;
  }

  return result;
}

function sha256(...parts) {
  return parts.reduce((hash, part) => hash.update(part), createHash("sha256")).digest();
}
