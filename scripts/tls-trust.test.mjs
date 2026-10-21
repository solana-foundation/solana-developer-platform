import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:https";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const preload = path.join(root, "packages/sdp-env-config/src/tls-trust.cjs");
const fixtures = readFileSync(new URL("./fixtures/tls/emudhra-roots.pem", import.meta.url), "utf8");

function nodeEnv() {
  const env = { ...process.env };
  for (const key of [
    "NODE_OPTIONS",
    "NODE_EXTRA_CA_CERTS",
    "NODE_USE_SYSTEM_CA",
    "NODE_TLS_REJECT_UNAUTHORIZED",
    "SSL_CERT_FILE",
    "SSL_CERT_DIR",
  ])
    delete env[key];
  env.NODE_OPTIONS = `--require=${preload}`;
  return env;
}

function runNode(source, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["-e", source], { env, timeout: 15_000 });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.once("error", reject);
    child.once("close", (code) => resolve({ code, stdout, stderr }));
  });
}

test("removes every affected root even when explicitly added, including in workers", async (t) => {
  const directory = mkdtempSync(path.join(tmpdir(), "sdp-tls-roots-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const bundle = path.join(directory, "extra.pem");
  writeFileSync(bundle, fixtures);
  const env = nodeEnv();
  env.NODE_EXTRA_CA_CERTS = bundle;
  const source = `
    const {getCACertificates}=require('node:tls');
    const {X509Certificate}=require('node:crypto');
    const {Worker}=require('node:worker_threads');
    const certs=getCACertificates('default');
    require('node:assert/strict')(certs.length>0);
    const subjects=certs.map(c=>new X509Certificate(c).subject);
    require('node:assert/strict')(!subjects.some(s=>/CN=(emSign ECC Root CA - G3|emSign Root TLS CA - G3|emSign Root CS CA - G3|AAA Certificate Services)$/.test(s)));
    new Worker(\`const {parentPort}=require('node:worker_threads');
      parentPort.postMessage(require('node:tls').getCACertificates('default'));\`,{eval:true})
      .on('message', workerCerts=>require('node:assert/strict').deepEqual(workerCerts,certs));
  `;
  const result = await runNode(source, env);
  assert.equal(result.code, 0, result.stderr);
});

test("preserves a private CA for fetch and HTTPS, and still checks hostnames", async (t) => {
  const directory = mkdtempSync(path.join(tmpdir(), "sdp-tls-private-"));
  chmodSync(directory, 0o700);
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const key = path.join(directory, "key.pem");
  const cert = path.join(directory, "cert.pem");
  execFileSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-days",
      "1",
      "-subj",
      "/CN=localhost",
      "-addext",
      "subjectAltName=DNS:localhost",
      "-keyout",
      key,
      "-out",
      cert,
    ],
    { stdio: "pipe" }
  );
  const bundle = path.join(directory, "extra.pem");
  writeFileSync(bundle, fixtures + readFileSync(cert, "utf8"));
  const server = createServer({ key: readFileSync(key), cert: readFileSync(cert) }, (_req, res) => {
    res.end("trusted-private-service");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const port = server.address().port;
  const env = nodeEnv();
  env.NODE_EXTRA_CA_CERTS = bundle;
  const result = await runNode(
    `
    (async()=>{
      const assert=require('node:assert/strict');
      const response=await fetch('https://localhost:${port}');
      assert.equal(await response.text(),'trusted-private-service');
      await new Promise((resolve,reject)=>require('node:https').get('https://localhost:${port}',res=>{
        assert.equal(res.statusCode,200);res.resume();res.on('end',resolve);
      }).on('error',reject));
      await assert.rejects(fetch('https://127.0.0.1:${port}'),e=>e.cause.code==='ERR_TLS_CERT_ALTNAME_INVALID');
    })().catch(e=>{console.error(e);process.exitCode=1});
  `,
    env
  );
  assert.equal(result.code, 0, result.stderr);
});

test("refuses to start when certificate verification is disabled", async () => {
  const env = nodeEnv();
  env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
  const result = await runNode("throw new Error('application must not start')", env);
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /certificate verification to stay enabled/);
  assert.doesNotMatch(result.stderr, /application must not start/);
});
