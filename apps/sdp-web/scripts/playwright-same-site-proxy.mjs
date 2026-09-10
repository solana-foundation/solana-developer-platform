#!/usr/bin/env node
// HTTPS -> HTTP reverse proxy in front of the Playwright web server.
//
// Why: the stage smoke runs against the production Clerk instance
// (clerk.platform.solana.com). Clerk sets its `__client` cookie with
// `Domain=clerk.platform.solana.com; SameSite=Lax` and `__client_uat` with
// `Domain=solana.com; Secure`. A page on http://localhost never sends the
// first and can never store the second, so `setActive` (session touch)
// returns 401 "signed_out" and clerkMiddleware bounces to /sign-in. The
// browser therefore has to sit on an https *.solana.com origin. Chromium is
// launched with --host-resolver-rules mapping that host to 127.0.0.1, and
// this proxy terminates TLS with a throwaway self-signed cert and forwards
// to the local `next start`, preserving Host and adding x-forwarded-*.
//
// Env:
//   SAME_SITE_HOST          hostname the browser will use (required)
//   SAME_SITE_PORT          https listen port (default 3443)
//   SAME_SITE_TARGET        upstream http origin (default http://localhost:3100)
//   SAME_SITE_CERT_DIR      where key.pem/cert.pem live (default .playwright-tls)
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import path from "node:path";

const host = process.env.SAME_SITE_HOST;
if (!host) {
  console.error("SAME_SITE_HOST is required");
  process.exit(1);
}
const port = Number(process.env.SAME_SITE_PORT ?? "3443");
const target = new URL(process.env.SAME_SITE_TARGET ?? "http://localhost:3100");
const certDir = path.resolve(process.env.SAME_SITE_CERT_DIR ?? ".playwright-tls");
const keyPath = path.join(certDir, "key.pem");
const certPath = path.join(certDir, "cert.pem");

if (!fs.existsSync(keyPath) || !fs.existsSync(certPath)) {
  fs.mkdirSync(certDir, { recursive: true });
  const result = spawnSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-days",
      "2",
      "-keyout",
      keyPath,
      "-out",
      certPath,
      "-subj",
      `/CN=${host}`,
      "-addext",
      `subjectAltName=DNS:${host}`,
    ],
    { stdio: ["ignore", "ignore", "pipe"], encoding: "utf8" }
  );
  if (result.status !== 0) {
    console.error("openssl failed to mint the same-site smoke certificate");
    console.error(result.stderr);
    process.exit(1);
  }
}

const server = https.createServer(
  { key: fs.readFileSync(keyPath), cert: fs.readFileSync(certPath) },
  (req, res) => {
    const headers = { ...req.headers };
    // Keep Host as the browser sent it so Next's server-action origin check
    // and Clerk's redirect URLs see the same-site origin, not localhost.
    headers["x-forwarded-host"] = req.headers.host ?? `${host}:${port}`;
    headers["x-forwarded-proto"] = "https";
    headers["x-forwarded-port"] = String(port);

    const upstream = http.request(
      {
        protocol: target.protocol,
        hostname: target.hostname,
        port: target.port,
        method: req.method,
        path: req.url,
        headers,
        setHost: false,
      },
      (upstreamRes) => {
        res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers);
        upstreamRes.pipe(res);
      }
    );
    upstream.on("error", (error) => {
      if (!res.headersSent) {
        res.writeHead(502, { "content-type": "text/plain" });
      }
      res.end(`same-site proxy: upstream ${target.origin} unavailable (${error.message})`);
    });
    req.pipe(upstream);
  }
);

server.listen(port, "127.0.0.1", () => {
  console.log(`same-site proxy: https://${host}:${port} -> ${target.origin}`);
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
