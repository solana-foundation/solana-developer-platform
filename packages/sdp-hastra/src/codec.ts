import { createHash } from "node:crypto";
import { getAddressDecoder } from "@solana/kit";
import { I128_MODULUS, I128_SIGN, MAX_ADMINISTRATORS } from "./constants";
import { SdpHastraError } from "./errors";

export function discriminator(namespace: "global" | "account" | "event", name: string): Buffer {
  return createHash("sha256").update(`${namespace}:${name}`).digest().subarray(0, 8);
}

export function assertDiscriminator(
  data: Buffer,
  namespace: "account" | "event",
  name: string
): void {
  const expected = discriminator(namespace, name);
  if (data.length < 8 || !data.subarray(0, 8).equals(expected)) {
    throw new SdpHastraError(
      "PROGRAM_MISMATCH",
      `Hastra returned data with an unexpected ${name} discriminator.`
    );
  }
}

export function pubkeyAt(data: Buffer, offset: number, label: string): string {
  if (offset < 0 || offset + 32 > data.length) {
    throw new SdpHastraError("PROGRAM_MISMATCH", `Hastra's ${label} account is truncated.`);
  }
  return getAddressDecoder().decode(data.subarray(offset, offset + 32));
}

export function readU64(data: Buffer, offset: number, label: string): bigint {
  if (offset < 0 || offset + 8 > data.length) {
    throw new SdpHastraError("PROGRAM_MISMATCH", `Hastra's ${label} account is truncated.`);
  }
  return data.readBigUInt64LE(offset);
}

export function readI64(data: Buffer, offset: number, label: string): bigint {
  if (offset < 0 || offset + 8 > data.length) {
    throw new SdpHastraError("PROGRAM_MISMATCH", `Hastra's ${label} account is truncated.`);
  }
  return data.readBigInt64LE(offset);
}

export function readI128(data: Buffer, offset: number, label: string): bigint {
  if (offset < 0 || offset + 16 > data.length) {
    throw new SdpHastraError("PROGRAM_MISMATCH", `Hastra's ${label} account is truncated.`);
  }
  const unsigned = data.readBigUInt64LE(offset) | (data.readBigUInt64LE(offset + 8) << 64n);
  return unsigned >= I128_SIGN ? unsigned - I128_MODULUS : unsigned;
}

export function skipPubkeyVector(data: Buffer, offset: number, label: string): number {
  if (offset + 4 > data.length) {
    throw new SdpHastraError("PROGRAM_MISMATCH", `Hastra's ${label} vector is truncated.`);
  }
  const length = data.readUInt32LE(offset);
  if (length > MAX_ADMINISTRATORS) {
    throw new SdpHastraError(
      "PROGRAM_MISMATCH",
      `Hastra's ${label} vector exceeds the audited v0.0.6 bound.`
    );
  }
  const next = offset + 4 + length * 32;
  if (next > data.length) {
    throw new SdpHastraError("PROGRAM_MISMATCH", `Hastra's ${label} vector is truncated.`);
  }
  return next;
}

export function anchorAmountData(name: string, amount: bigint): string {
  const data = Buffer.alloc(16);
  discriminator("global", name).copy(data, 0);
  data.writeBigUInt64LE(amount, 8);
  return data.toString("base64");
}

export function anchorNoArgsData(name: string): string {
  return discriminator("global", name).toString("base64");
}
