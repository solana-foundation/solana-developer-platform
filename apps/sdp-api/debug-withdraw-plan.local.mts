import { KaminoVaultDirectClient } from "@sdp/kamino";
const RPC = "http://127.0.0.1:8899";
const OWNER = process.env.OWNER as string;
const VAULT = "7uib8xGAwkaPz4ZGCA6t8sSEid5Yp9ty13PHUweTypx";

const client = new KaminoVaultDirectClient(
  async () => RPC,
  (_label, operation) => operation(() => {})
);
const plan = await client.buildVaultWithdrawal(
  { env: {} as never, environment: "sandbox" },
  { providerReference: VAULT, owner: OWNER, shares: process.env.SHARES ?? "10" }
);
console.log("cluster:", plan.cluster, "lookupTables:", plan.lookupTables);
plan.instructions.forEach((ix, i) => {
  console.log(`ix[${i}] program=${ix.programAddress} accounts=${ix.accounts.length} dataLen=${Buffer.from(ix.data, "base64").length} dataHead=${Buffer.from(ix.data, "base64").subarray(0, 8).toString("hex")}`);
  ix.accounts.forEach((a, j) => console.log(`   [${j}] ${a.address} role=${a.role}`));
});
