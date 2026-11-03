import { execFileSync } from "node:child_process";
import { createPublicKey } from "node:crypto";
import { describe, expect, it } from "vitest";
import { generateFireblocksCsr } from "./fireblocks-csr";

describe("Fireblocks CSR generation", () => {
  it("creates a valid RSA-4096 PKCS#10 request, independently verified by OpenSSL", async () => {
    const id = `fbcsr_${crypto.randomUUID()}`;
    const { csrPem, privateKeyPem } = await generateFireblocksCsr(id);
    const verification = execFileSync("openssl", ["req", "-verify", "-noout", "-text"], {
      input: csrPem,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
    });
    expect(verification).toContain(id);
    expect(verification).toMatch(/4096 bit/);
    const csrPublicKey = execFileSync("openssl", ["req", "-pubkey", "-noout"], {
      input: csrPem,
      encoding: "utf8",
    });
    expect(csrPublicKey).toBe(
      createPublicKey(privateKeyPem).export({ type: "spki", format: "pem" })
    );
    expect(csrPem).not.toContain("PRIVATE KEY");
  });
});
