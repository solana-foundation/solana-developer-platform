// Places each built program of this workspace on a local surfnet at the address that its
// `declare_id!` names, with the `surfnet_setAccount` cheatcode. The program keypairs are not in
// git, so a normal deploy cannot use those addresses. Run `just build-programs` first, then:
//
//   node deploy-surfnet.mjs [rpc]
//
// Each program goes in as an upgradeable program, as on a real cluster, with the `surfnet_writeProgram`
// cheatcode. A setup script then names the registry's upgrade authority with
// `surfnet_setProgramAuthority`, because only that authority creates the registry config. This is
// for a local surfnet only.
//
// The IDL that `cargo run -p idl` writes to `target/idl` goes in beside its program, so that Solana
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

const programs = readdirSync(new URL(".", import.meta.url), { withFileTypes: true })
  .filter((entry) => entry.isDirectory() && existsSync(new URL(`./${entry.name}/src/lib.rs`, import.meta.url)))
  .map((entry) => {
    const source = readFileSync(new URL(`./${entry.name}/src/lib.rs`, import.meta.url), "utf8");
    const address = source.match(/declare_id!\("([1-9A-HJ-NP-Za-km-z]+)"\)/)?.[1];

    return { name: entry.name.replaceAll("-", "_"), address };
  })
  .filter(({ address }) => address);

for (const { name, address } of programs) {
  const path = new URL(`./target/deploy/${name}.so`, import.meta.url);

  if (!existsSync(path)) throw new Error(`${name}.so is not built. Run \`just build-programs\`.`);

  const data = readFileSync(path).toString("hex");
  await rpc("surfnet_writeProgram", [address, data, 0]);
  console.log(`placed ${name} at ${address}`);

  const idlPath = new URL(`./target/idl/${name}.json`, import.meta.url);

  if (!existsSync(idlPath)) continue;

  const idl = idlAccount(address, JSON.parse(readFileSync(idlPath, "utf8")));
  await rpc("surfnet_setAccount", [idl.address, { lamports: LAMPORTS, data: idl.data.toString("hex"), owner: address }]);
  console.log(`placed the IDL of ${name} at ${idl.address}`);
}
