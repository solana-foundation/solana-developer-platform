// Credential-free deployment smoke check. Run with the actual Node runtime and
// preload/environment of the deployment, not just the host's curl/browser.
import assert from "node:assert/strict";
import { connect } from "node:tls";

const certificateErrors = new Set([
  "CERT_REVOKED",
  "CERT_UNTRUSTED",
  "UNABLE_TO_GET_ISSUER_CERT",
  "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "SELF_SIGNED_CERT_IN_CHAIN",
]);

function check(host, shouldTrust) {
  return new Promise((resolve, reject) => {
    const socket = connect({ host, port: 443, servername: host, rejectUnauthorized: true });
    socket.setTimeout(10_000, () => socket.destroy(new Error(`${host}: connection timed out`)));
    socket.once("secureConnect", () => {
      socket.destroy();
      if (!shouldTrust) {
        reject(new Error(`${host}: compromised chain was accepted`));
      } else {
        console.log(`PASS ${host}: trusted control`);
        resolve();
      }
    });
    socket.once("error", (error) => {
      if (!shouldTrust && certificateErrors.has(error.code)) {
        console.log(`PASS ${host}: ${error.code}`);
        resolve();
      } else {
        // DNS, timeout, hostname and expiry failures cannot prove containment.
        reject(error);
      }
    });
  });
}

const probes = [check("nodejs.org", true)];
for (const purpose of ["dv", "ov", "ev"]) {
  for (const series of ["g3b", "g3c"]) {
    for (const issuer of ["emudhra", "aaa-emudhra"]) {
      probes.push(check(`${purpose}-${series}-${issuer}.we-have-a-problem.com`, false));
    }
  }
}
const results = await Promise.allSettled(probes);
for (const result of results) {
  if (result.status === "rejected") console.error(result.reason);
}
assert(
  results.every((result) => result.status === "fulfilled"),
  "TLS trust smoke check failed"
);
