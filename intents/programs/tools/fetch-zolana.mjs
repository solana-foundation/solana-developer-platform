// Fetches the Helius privacy rings (Zolana) release that `zolana-artifacts.json` pins into
// `intents/target/zolana`: the programs, the localnet account snapshot, and the Photon indexer and
// prover binaries for linux-x64. Each file must match its pinned SHA-256, and a file that already
// matches is kept. From `intents`:
//
//   node programs/tools/fetch-zolana.mjs

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";

const PINNED = JSON.parse(readFileSync(new URL("./zolana-artifacts.json", import.meta.url), "utf8"));
const TARGET = new URL("../../target/zolana/", import.meta.url).pathname;

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

async function fetchPinned({ asset, sha256: pinned }) {
  const path = `${TARGET}${asset}`;

  if (existsSync(path) && sha256(readFileSync(path)) === pinned) {
    return path;
  }

  const response = await fetch(`${PINNED.url}/${PINNED.release}/${asset}`);
  if (!response.ok) throw new Error(`${asset}: HTTP ${response.status}`);

  const bytes = Buffer.from(await response.arrayBuffer());
  if (sha256(bytes) !== pinned) throw new Error(`${asset} does not match its pinned SHA-256`);

  writeFileSync(path, bytes);
  console.log(`fetched ${asset}`);

  return path;
}

mkdirSync(`${TARGET}accounts`, { recursive: true });

for (const program of PINNED.programs) {
  await fetchPinned(program);
}

const accounts = await fetchPinned(PINNED.accounts);
execFileSync("tar", ["-xzf", accounts, "-C", `${TARGET}accounts`]);

for (const binary of PINNED.binaries) {
  chmodSync(await fetchPinned(binary), 0o755);
}

console.log(`Zolana ${PINNED.release} is in ${TARGET}`);
