import { createPublicKey, generateKeyPair, sign } from "node:crypto";

/** PKCS#10 (RFC 2986) using Node's RSA implementation; no private key leaves the API. */
export async function generateFireblocksCsr(keyId: string): Promise<{
  csrPem: string;
  privateKeyPem: string;
}> {
  const privateKey = await new Promise<import("node:crypto").KeyObject>((resolve, reject) => {
    generateKeyPair(
      "rsa",
      { modulusLength: 4096, publicExponent: 0x10001 },
      (error, _publicKey, key) => {
        if (error) reject(error);
        else resolve(key);
      }
    );
  });
  const publicKey = createPublicKey(privateKey).export({ type: "spki", format: "der" });
  // Subject CN is an opaque generated identifier, never user-provided ASN.1 or personal data.
  const subject = der(
    0x30,
    der(
      0x31,
      der(
        0x30,
        Buffer.concat([
          Buffer.from("0603550403", "hex"),
          der(0x0c, Buffer.from(`SDP Fireblocks ${keyId}`)),
        ])
      )
    )
  );
  const info = der(
    0x30,
    Buffer.concat([Buffer.from("020100", "hex"), subject, publicKey, Buffer.from("a000", "hex")])
  );
  // sha256WithRSAEncryption OID, NULL parameters; BIT STRING starts with zero unused bits.
  const csr = der(
    0x30,
    Buffer.concat([
      info,
      // biome-ignore lint/security/noSecrets: DER algorithm identifier for SHA256 with RSA, not key material.
      Buffer.from("300d06092a864886f70d01010b0500", "hex"),
      der(0x03, Buffer.concat([Buffer.from([0]), sign("RSA-SHA256", info, privateKey)])),
    ])
  );
  return {
    csrPem: `-----BEGIN CERTIFICATE REQUEST-----\n${csr
      .toString("base64")
      .match(/.{1,64}/g)
      ?.join("\n")}\n-----END CERTIFICATE REQUEST-----\n`,
    privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
  };
}

function der(tag: number, content: Buffer): Buffer {
  const size = content.length;
  const length =
    size < 128
      ? Buffer.from([size])
      : (() => {
          let hex = size.toString(16);
          if (hex.length % 2) hex = `0${hex}`;
          const bytes = Buffer.from(hex, "hex");
          return Buffer.concat([Buffer.from([0x80 | bytes.length]), bytes]);
        })();
  return Buffer.concat([Buffer.from([tag]), length, content]);
}
