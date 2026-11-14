// Places each built program of this workspace on a local surfnet at the address that its
// `declare_id!` names, with the `surfnet_setAccount` cheatcode. The program keypairs are not in
// git, so a normal deploy cannot use those addresses. Run `just build-programs` first, then:
//
//   node programs/tools/deploy-surfnet.mjs [rpc]
//
// Each program goes in as an upgradeable program, as on a real cluster, with the `surfnet_writeProgram`
// cheatcode. A setup script then names the registry's upgrade authority with
// `surfnet_setProgramAuthority`, because only that authority creates the registry config. This is
// for a local surfnet only.
//
// Zolana's programs and localnet accounts go in too, when `just fetch-zolana` has fetched them.
//
// The IDL that `just idl` writes to `target/idl` goes in beside its program, so that Solana
// Explorer decodes the program's instructions.

import { existsSync, readdirSync, readFileSync } from "node:fs";

import { idlAccount } from "./anchor-idl.mjs";

const RPC = process.argv[2] ?? "http://127.0.0.1:8899";
const LAMPORTS = 10_000_000_000;

async function rpc(method, params) {
  const response = await fetch(RPC, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const { result, error } = await response.json();

  if (error) throw new Error(`${method}: ${JSON.stringify(error)}`);

  return result;
}

const programs = readdirSync(new URL("..", import.meta.url), { withFileTypes: true })
  .filter((entry) => entry.isDirectory() && existsSync(new URL(`../${entry.name}/src/lib.rs`, import.meta.url)))
  .map((entry) => {
    const source = readFileSync(new URL(`../${entry.name}/src/lib.rs`, import.meta.url), "utf8");
    const address = source.match(/declare_id!\("([1-9A-HJ-NP-Za-km-z]+)"\)/)?.[1];

    return { name: entry.name.replaceAll("-", "_"), address };
  })
  .filter(({ address }) => address);

for (const { name, address } of programs) {
  const path = new URL(`../target/deploy/${name}.so`, import.meta.url);

  if (!existsSync(path)) throw new Error(`${name}.so is not built. Run \`just build-programs\`.`);

  const data = readFileSync(path).toString("hex");
  await rpc("surfnet_writeProgram", [address, data, 0]);
  console.log(`placed ${name} at ${address}`);

  const idlPath = new URL(`../target/idl/${name}.json`, import.meta.url);

  if (!existsSync(idlPath)) continue;

  const idl = idlAccount(address, JSON.parse(readFileSync(idlPath, "utf8")));
  await rpc("surfnet_setAccount", [idl.address, { lamports: LAMPORTS, data: idl.data.toString("hex"), owner: address }]);
  console.log(`placed the IDL of ${name} at ${idl.address}`);
}

// Helius privacy rings: Zolana's programs and its localnet account snapshot (the protocol config,
// the asset counter, and the pool tree), when `fetch-zolana.mjs` has fetched them. Zolana is also
// deployed on mainnet at the same address, so the fork's program is replaced by the release that the
// local Photon and prover match.
const ZOLANA = new URL("../../target/zolana/", import.meta.url);
const zolana = JSON.parse(readFileSync(new URL("./zolana-artifacts.json", import.meta.url), "utf8"));

if (existsSync(ZOLANA)) {
  for (const { asset, address } of zolana.programs) {
    await rpc("surfnet_writeProgram", [address, readFileSync(new URL(asset, ZOLANA)).toString("hex"), 0]);
    console.log(`placed Zolana's ${asset} at ${address}`);
  }

  for (const file of readdirSync(new URL("accounts/", ZOLANA))) {
    const { pubkey, account } = JSON.parse(readFileSync(new URL(`accounts/${file}`, ZOLANA), "utf8"));
    const data = Buffer.from(account.data[0], "base64").toString("hex");
    await rpc("surfnet_setAccount", [pubkey, { lamports: account.lamports, data, owner: account.owner, executable: account.executable }]);
  }

  console.log("placed Zolana's localnet accounts");
} else {
  console.log("Zolana is not fetched, so the surfnet has no privacy rings. Run `just fetch-zolana`.");
}
