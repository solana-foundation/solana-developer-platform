// Fetches the mainnet programs that the tests run in LiteSVM, and checks each against its pinned
// SHA-256 in `fixture-programs.json`. The binaries stay out of git, because they are the protocols'
// licensed programs. Each `file` in the JSON is relative to `programs`. From `intents`:
//
//   node programs/tools/fetch-programs.mjs [rpc]
//
// A file whose hash already matches is kept. A program that changed on mainnet fails the check,
// because the account fixtures were dumped against the pinned version. Dump the account fixtures
// again, then pin the new hash.

import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";

const RPC = process.argv[2] ?? "https://api.mainnet-beta.solana.com";
const PROGRAMS = JSON.parse(readFileSync(new URL("./fixture-programs.json", import.meta.url)));

/// A program data account holds a 45-byte header, then the ELF, then zeros.
const PROGRAM_DATA_HEADER = 45;
const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

function base58(bytes) {
  let value = 0n;
  for (const byte of bytes) value = value * 256n + BigInt(byte);

  let text = "";
  for (; value > 0n; value /= 58n) text = ALPHABET[Number(value % 58n)] + text;

  const zeros = bytes.findIndex((byte) => byte !== 0);
  return "1".repeat(zeros === -1 ? bytes.length : zeros) + text;
}

async function account(address) {
  const response = await fetch(RPC, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getAccountInfo", params: [address, { encoding: "base64" }] }),
  });
  const { result, error } = await response.json();

  if (error || !result?.value) throw new Error(`cannot read ${address}: ${JSON.stringify(error ?? "no account")}`);

  return Buffer.from(result.value.data[0], "base64");
}

/// The ELF ends with its section headers.
function elf(bytes) {
  const sectionHeaders = Number(bytes.readBigUInt64LE(0x28));
  const sectionHeaderLen = bytes.readUInt16LE(0x3a);
  const sectionHeaderCount = bytes.readUInt16LE(0x3c);

  return bytes.subarray(0, sectionHeaders + sectionHeaderLen * sectionHeaderCount);
}

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
let failed = false;

for (const { program, file, sha256: pinned } of PROGRAMS) {
  const path = new URL(`../${file}`, import.meta.url);

  if (existsSync(path) && sha256(readFileSync(path)) === pinned) {
    continue;
  }

  const programAccount = await account(program);
  const programData = await account(base58(programAccount.subarray(4, 36)));
  const binary = elf(programData.subarray(PROGRAM_DATA_HEADER));

  if (sha256(binary) !== pinned) {
    console.error(`${program} changed on mainnet: ${sha256(binary)}, pinned ${pinned}`);
    failed = true;
    continue;
  }

  writeFileSync(path, binary);
  console.log(`fetched ${file}`);
}

process.exit(failed ? 1 : 0);
