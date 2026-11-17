// Sandbox only: signs SDP's base64 transaction with test-wallet.json.
import { readFile } from "node:fs/promises";
import {
  createKeyPairFromBytes,
  getBase64EncodedWireTransaction,
  getBase64Encoder,
  getTransactionDecoder,
  partiallySignTransaction,
} from "@solana/kit";

const keyPair = await createKeyPairFromBytes(
  new Uint8Array(JSON.parse(await readFile("test-wallet.json", "utf8"))),
);
const unsigned = getTransactionDecoder().decode(getBase64Encoder().encode(process.argv[2]));
const signed = await partiallySignTransaction([keyPair], unsigned);
process.stdout.write(getBase64EncodedWireTransaction(signed));
