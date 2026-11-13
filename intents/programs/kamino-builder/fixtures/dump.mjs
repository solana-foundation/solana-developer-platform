// Writes the fixtures of the kamino-builder tests from mainnet: the kvault and klend programs, and
// the accounts of one vault at one slot. Run it from this directory:
//
//   node dump.mjs [vault] [rpc]
//
// The tests read `accounts.json`, `kvault.so`, and `klend.so`. Every account except the programs is
// read in one `getMultipleAccounts` call, so the accounts and the clock are of one slot.
//
// `kvault.so` and `klend.so` are the Kamino mainnet programs, under Kamino's licenses. They stay out
// of git, and `just fetch-programs` in `intents` fetches them. After a new dump, pin
// their new hashes in `intents/programs/tools/fixture-programs.json`.

import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";

const VAULT = process.argv[2] ?? "HDsayqAsDWy3QvANGqh2yNraqcD8Fnjgh73Mhb3WRS5E";
const RPC = process.argv[3] ?? "https://api.mainnet-beta.solana.com";

const KVAULT = "KvauGMspG5k6rtzrqqn7WNn3oZdyKqLKwK2XWQ8FLjd";
const KLEND = "KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD";
const CLOCK = "SysvarC1ock11111111111111111111111111111111";
const DEFAULT_ADDRESS = "11111111111111111111111111111111";

// The offsets in the account data, the 8-byte discriminator included.
const VAULT_TOKEN_MINT = 80;
const VAULT_TOKEN_VAULT = 120;
const VAULT_SHARES_MINT = 184;
const VAULT_ALLOCATIONS = 312;
const ALLOCATION_LEN = 2160;
const MAX_RESERVES = 25;
const RESERVE_LENDING_MARKET = 32;
const RESERVE_LIQUIDITY_SUPPLY = 160;
const RESERVE_COLLATERAL_MINT = 2560;
const PROGRAM_DATA_HEADER = 45;

const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

function encode(bytes) {
  let value = 0n;
  for (const byte of bytes) value = value * 256n + BigInt(byte);
  let text = "";
  while (value > 0n) {
    text = ALPHABET[Number(value % 58n)] + text;
    value /= 58n;
  }
  for (const byte of bytes) {
    if (byte !== 0) break;
    text = `1${text}`;
  }
  return text;
}

function decode(text) {
  let value = 0n;
  for (const char of text) value = value * 58n + BigInt(ALPHABET.indexOf(char));
  const bytes = [];
  while (value > 0n) {
    bytes.unshift(Number(value % 256n));
    value /= 256n;
  }
  for (const char of text) {
    if (char !== "1") break;
    bytes.unshift(0);
  }
  return Buffer.from(bytes);
}

// Ed25519: a PDA is a SHA-256 that does not decode to a curve point.
const P = 2n ** 255n - 19n;
const D = (-121665n * inverse(121666n)) % P;

function power(base, exponent) {
  let result = 1n;
  let square = ((base % P) + P) % P;
  for (let rest = exponent; rest > 0n; rest >>= 1n) {
    if (rest & 1n) result = (result * square) % P;
    square = (square * square) % P;
  }
  return result;
}

function inverse(value) {
  return power(value, P - 2n);
}

function onCurve(bytes) {
  const copy = Buffer.from(bytes);
  copy[31] &= 0x7f;
  const y = BigInt(`0x${Buffer.from(copy).reverse().toString("hex")}`);
  if (y >= P) return false;
  const y2 = (y * y) % P;
  const x2 = (((y2 - 1n + P) % P) * inverse((D * y2 + 1n) % P)) % P;
  return x2 === 0n || power(x2, (P - 1n) / 2n) === 1n;
}

function findProgramAddress(seeds, program) {
  for (let bump = 255; bump >= 0; bump -= 1) {
    const hash = createHash("sha256")
      .update(Buffer.concat([...seeds, Buffer.from([bump]), decode(program), Buffer.from("ProgramDerivedAddress")]))
      .digest();
    if (!onCurve(hash)) return encode(hash);
  }
  throw new Error("no program address");
}

async function rpc(method, params) {
  const response = await fetch(RPC, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const body = await response.json();
  if (body.error) throw new Error(`${method}: ${JSON.stringify(body.error)}`);
  return body.result;
}

async function accounts(addresses) {
  const result = await rpc("getMultipleAccounts", [addresses, { encoding: "base64", commitment: "confirmed" }]);
  return result.value.map((account) => account && { ...account, bytes: Buffer.from(account.data[0], "base64") });
}

const address = (bytes, offset) => encode(bytes.subarray(offset, offset + 32));

// Program data is larger than the ELF, and the rest is zeros. The ELF ends with its section headers.
function elf(bytes) {
  const sectionHeaders = Number(bytes.readBigUInt64LE(0x28));
  const sectionHeaderLen = bytes.readUInt16LE(0x3a);
  const sectionHeaderCount = bytes.readUInt16LE(0x3c);
  return bytes.subarray(0, sectionHeaders + sectionHeaderLen * sectionHeaderCount);
}

async function program(id, file) {
  const [account] = await accounts([id]);
  const [programData] = await accounts([address(account.bytes, 4)]);
  writeFileSync(file, elf(programData.bytes.subarray(PROGRAM_DATA_HEADER)));
}

const [vault] = await accounts([VAULT]);
const allocations = Array.from({ length: MAX_RESERVES }, (_, index) => VAULT_ALLOCATIONS + index * ALLOCATION_LEN)
  .map((offset) => ({ reserve: address(vault.bytes, offset), ctokenVault: address(vault.bytes, offset + 32) }))
  .filter((allocation) => allocation.reserve !== DEFAULT_ADDRESS);
const reserves = await accounts(allocations.map((allocation) => allocation.reserve));

const addresses = [
  ...new Set([
    CLOCK,
    VAULT,
    address(vault.bytes, VAULT_TOKEN_MINT),
    address(vault.bytes, VAULT_TOKEN_VAULT),
    address(vault.bytes, VAULT_SHARES_MINT),
    findProgramAddress([Buffer.from("global_config")], KVAULT),
    ...allocations.flatMap((allocation) => [allocation.reserve, allocation.ctokenVault]),
    ...reserves.flatMap((reserve) => [
      address(reserve.bytes, RESERVE_LENDING_MARKET),
      address(reserve.bytes, RESERVE_LIQUIDITY_SUPPLY),
      address(reserve.bytes, RESERVE_COLLATERAL_MINT),
    ]),
  ]),
];
const fetched = await accounts(addresses);
const fixture = addresses
  .map((pubkey, index) => ({ pubkey, account: fetched[index] }))
  .filter((entry) => entry.account !== null)
  .map(({ pubkey, account }) => ({
    pubkey,
    account: {
      lamports: account.lamports,
      data: account.data,
      owner: account.owner,
      executable: account.executable,
      space: account.space,
    },
  }));

writeFileSync("accounts.json", `${JSON.stringify(fixture, null, 1)}\n`);
await program(KVAULT, "kvault.so");
await program(KLEND, "klend.so");
console.log(`wrote ${fixture.length} accounts of ${VAULT}`);
