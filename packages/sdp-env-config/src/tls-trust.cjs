/* biome-ignore-all lint/security/noSecrets: public CA SPKI fingerprints, not secrets */
// Temporary eMudhra containment while Node's native intermediate-key blocklist
// rolls out: https://github.com/nodejs/node/pull/66871
// TODO: upgrade to released, verified Node fixes and remove this policy and its
// wiring using docs/ops/emudhra-tls-mitigation.md#retire-this-mitigation.
// Preload before any connections (`node --require .../tls-trust.cjs`). This file
// intentionally needs no dependencies, so container/package installs can use it.
const { createHash, X509Certificate } = require("node:crypto");
const { getCACertificates, setDefaultCACertificates } = require("node:tls");

// SPKI SHA-256, not subject names: also removes cross-signed forms of these keys.
// Source: https://emudhra.we-have-a-problem.com/roots.json (2026-10-20).
// Root removal is broader than Node's native fix: legitimate chains through
// these roots are also distrusted. Keep until every deployed runtime is patched.
const blockedRootKeys = new Set([
  "8d417db2dd8bf5e3084d1e3f196d583849d81bdd4c00c70b9d39369e96b8c782", // emSign ECC Root CA - G3
  "bd153ed7b0434f6886b17bce8bbe84ed340c7132d702a8f4fa318f756ecbd6f3", // AAA Certificate Services
  "c619e4780ed8e0abeda24ad732567de4383a7ea941338f6d1a7d1b49ac792fe9", // emSign Root TLS CA - G3
  "0a6c2b2ca5b364207954171987ac9d2178561569d8205457e77ca90c32ede282", // emSign Root CS CA - G3
]);

if (typeof setDefaultCACertificates !== "function") {
  throw new Error("SDP TLS mitigation requires Node >=24.14 (or >=22.19 for CI tools).");
}
if (process.env.NODE_TLS_REJECT_UNAUTHORIZED === "0") {
  throw new Error("SDP TLS mitigation requires certificate verification to stay enabled.");
}

// Preserve unrelated system/private/extra CAs already selected by the operator.
// Replacing the defaults, rather than adding a clean bundle, removes trust.
const certificates = getCACertificates("default").filter((pem) => {
  const key = new X509Certificate(pem).publicKey.export({ type: "spki", format: "der" });
  return !blockedRootKeys.has(createHash("sha256").update(key).digest("hex"));
});
if (certificates.length === 0) {
  throw new Error("SDP TLS mitigation refused an empty CA trust store.");
}
setDefaultCACertificates(certificates);
