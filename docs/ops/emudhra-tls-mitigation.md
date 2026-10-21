# Temporary eMudhra TLS mitigation

The [October 2026 disclosure](https://emudhra.we-have-a-problem.com/) concerns
compromised intermediate CA keys. An attacker able to intercept outbound traffic
can impersonate a provider even when that provider normally uses another CA.
[Node's native intermediate-key blocklist](https://github.com/nodejs/node/pull/66871)
is the preferred permanent fix; merging it upstream does not patch existing images.

## What this change protects

`@sdp/env-config/tls-trust` replaces Node's default CA list before connections,
removing the four trust-anchor public keys in the disclosure's `roots.json`.
Matching SPKI hashes also removes cross-signed copies of those same keys. Other
configured CAs, including private CAs from `NODE_EXTRA_CA_CERTS`, are preserved.
Certificate and hostname verification remain enabled. There are no online CRL
lookups or extra RPC/provider calls: before/after request counts are unchanged.

A TLS certificate normally builds a chain from the server certificate through
intermediate CAs to a trusted root. The stolen keys belong to intermediates; this
workaround removes the roots that would let their chains be trusted. It hashes
each root's public key, filters the affected keys out of Node's selected CA list,
and installs that filtered list with `tls.setDefaultCACertificates` before TLS
connections start. It does not modify the Node executable or the operating
system's trust store. Node's native fix blocks the compromised intermediate keys
directly, so it can preserve legitimate chains through the same roots.

- All three application Dockerfiles preload the policy in the shared `tls-base`
  stage before corepack/npm/pnpm. The runner derives from that stage too. API,
  worker, migrations, and child Node processes inherit the preload.
- API startup and both Next.js applications also load the policy in source.
  Next config protects its process during builds; Node instrumentation applies
  it before each server instance handles requests, including on Vercel.
- Surfpool Node containers use the same preload before installing dependencies.
- CI Bash steps load it through `BASH_ENV` before installs/scripts. Turbo preserves
  `NODE_OPTIONS` for its child tasks. GitHub action runtimes, the initial checkout,
  managed build-platform bootstrap, curl, and other languages still require their
  own vendor updates; this preload only controls Node processes that load it.

This is deliberately broader than the native Node fix: legitimate services
chaining exclusively to a removed root also fail. Validate provider connectivity
in stage. A client that explicitly supplies `ca`/`secureContext` overrides Node's
defaults and must use independently patched trust. Existing sockets and sessions
are not repaired: restart Node processes and deploy new instances.

## Release and verification

1. Build new images from this commit. The added stage invalidates the previous
   layers; simply restarting an old pinned image does not install this mitigation.
2. Deploy the new API image to **both API and worker**, and redeploy web/docs
   server runtimes. Use the normal stage smoke and production promotion gates.
3. Run the following with the deployed image's Node runtime and its real preload
   environment (copy/mount the checker into the container if needed):

   ```sh
   node scripts/check-tls-trust.mjs
   ```

   It requires all twelve published compromised-chain hosts to fail certificate
   validation and a normal control to connect. DNS errors, timeouts, certificate
   expiry, and hostname errors do **not** count as protection. No credentials are
   sent. Do not use `curl` or a browser as a substitute for testing Node.

4. Check normal Clerk/JWKS, custody, ramp, and RPC traffic in stage, then production.
   Update developer OS/browser/CA packages and non-Node tooling separately using
   the disclosure's vendor guidance.

Offline regression tests run with `node --test scripts/tls-trust.test.mjs` and
are included in `pnpm test:scripts`. They cover reintroduction through extra CAs,
worker inheritance, private-CA connectivity for fetch/HTTPS, hostname validation,
and refusal to disable certificate verification.

## Local Node

To use the policy before the native fix is deployed, set an **absolute** preload
path in `NODE_OPTIONS`, preserving other existing options:

```sh
export NODE_OPTIONS="--require=/absolute/repo/packages/sdp-env-config/src/tls-trust.cjs${NODE_OPTIONS:+ $NODE_OPTIONS}"
```

The policy uses Node's `tls.setDefaultCACertificates` API (24.5+/22.19+); SDP's
declared minimum is 24.14. It fails closed on an unsupported runtime. The preload
must be present for each worker/child process, not just an already-running parent.

## Retire this mitigation

**This is temporary. Once Node publishes numbered releases containing the native
fix, upgrade our runtimes and remove the root-removal policy in a follow-up PR.**
An upstream merge, a release announcement for a different Node major, or updating
the OS CA package is not enough. Do not guess the first fixed version: confirm
the release notes/backport for each Node line we actually use and record those
versions and the tested image digests in the removal PR.

1. Upgrade every affected runtime: the pinned images in all three app Dockerfiles
   and both Surfpool Dockerfiles, CI Node versions, managed web/docs build and
   server runtimes, and developer Node installations. Update version declarations
   and minimums as needed so a fresh install cannot select an unpatched runtime.
   Verify the Node version inside the actual image or managed runtime, not just
   the version requested in configuration.
2. Prove the native fix works **without any mitigation loaded**. In an isolated
   candidate image or fresh process, run the live checker using the actual patched
   Node executable, bypassing any local launcher that adds the preload:

   ```sh
   env -u NODE_OPTIONS /absolute/path/to/patched/node scripts/check-tls-trust.mjs
   ```

   This clears Node options only for that check. Start a new process: clearing an
   environment variable cannot undo an already-loaded policy. All twelve paths
   must fail with certificate trust errors and the normal control must connect.
   If the published test hosts are retired or expire, use maintained test chains
   for the compromised keys; a network failure or expiry is not proof of the fix.
3. Remove the temporary policy and its wiring together: `tls-trust.cjs` and its
   declaration/package export; API/Next config/instrumentation imports; Docker
   preload copies, `NODE_OPTIONS` and the temporary stage structure; CI
   `node-trust-env.sh` and its `BASH_ENV` entries; and the Turbo passthrough added
   for this workaround. Remove dependencies or module-boundary allowances only
   if no remaining code uses them, and regenerate the lockfile/module map with
   their owning tools. Retire tests/fixtures that assert broad root removal;
   retain the live checker and adapt applicable TLS verification tests to the
   native fix. Keep unrelated Node options and normal TLS verification enabled.
4. Build and deploy the patched artifacts through stage and normal production
   gates, including **both API and worker** and web/docs instances. Repeat the
   native-fix check and normal Clerk/JWKS, custody, ramp and RPC smoke checks.
   Complete retirement only when every active instance uses a verified fixed
   runtime; do not roll back to an unpatched image without restoring mitigation.
5. After verifying each developer's patched executable, remove its temporary
   shell initialization and Node launcher/preload configuration, preserving any
   unrelated configuration. Restart shells, dev servers and other Node processes,
   then rerun the checker with the normal `node` command. Merely upgrading a Node
   binary does not remove these local wrappers or restart running processes.

The incident alone is not evidence that SDP credentials were intercepted.
