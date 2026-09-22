# vendor/

One tarball, here for one reason: the confidential-transfer surface this repo compiles against is not published yet.

`solana-mosaic-sdk-0.2.1-003f3aa.tgz` is `pnpm pack` of `packages/sdk` from [solana-foundation/mosaic#85](https://github.com/solana-foundation/mosaic/pull/85) at commit `003f3aa` — Kit v8, token-2022 0.18, wallet-only key derivation, transaction-v1 planning, and confidential mint/burn. The `@solana/mosaic-sdk` override in the root `package.json` points at it, and that is what actually resolves; the catalog entry is only what the pinned-dependency check reads.

A tarball rather than a `link:` to a local checkout because CI and the production image have no such checkout, and rather than a git dependency because the package builds from the monorepo's tsconfig and ships `dist` only. Its integrity hash is in `pnpm-lock.yaml`, so replacing the file without updating the lockfile fails the install rather than silently changing what is built.

## Removing it

The pending changesets on that branch are `major`, so the release publishes as **1.0.0**, not 0.2.1. When it lands:

1. Delete this directory.
2. Drop the `@solana/mosaic-sdk` override from the root `package.json`.
3. Set `@solana/mosaic-sdk` to `1.0.0` in `pnpm-workspace.yaml`, and move `@solana-program/token-2022` to `0.18.0` at the same time so the tree settles on one copy — its release cooldown will have passed by then.
4. Drop `COPY vendor ./vendor` from `apps/sdp-api/Dockerfile`, `apps/sdp-web/Dockerfile` and `apps/sdp-docs/Dockerfile` (the docs image installs `--filter @sdp/api...`, which reaches the SDK through `@sdp/issuance`).

## Refreshing it

While the PR is still open, a change to the SDK means a new tarball:

```sh
cd <mosaic>/packages/sdk && pnpm build && pnpm pack --pack-destination <sdp>/vendor
```

Name it for the mosaic commit it came from, delete the old one, update the override path, and run `pnpm install` so the lockfile records the new hash.
