// Places each built program of this workspace on a local surfnet at the address that its
// `declare_id!` names, with the `surfnet_setAccount` cheatcode. The program keypairs are not in
// git, so a normal deploy cannot use those addresses. Run `just build-programs` first, then:
//
//   node deploy-surfnet.mjs [rpc]
//
// Each program goes in as an executable account of BPF Loader 2, which runs it like any other
// program and has no upgrade authority. This is for a local surfnet only.

import { existsSync, readdirSync, readFileSync } from "node:fs";

const RPC = process.argv[2] ?? "http://127.0.0.1:8899";
const LOADER = "BPFLoader2111111111111111111111111111111111";
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
  await rpc("surfnet_setAccount", [address, { lamports: LAMPORTS, data, owner: LOADER, executable: true }]);
  console.log(`placed ${name} at ${address}`);
}
