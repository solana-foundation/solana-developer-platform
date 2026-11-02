#!/usr/bin/env node
import { z } from "zod";
import { runCli } from "./run";

process.exitCode = await runCli(process.argv.slice(2), {
  env: process.env,
  fetcher: fetch,
  readStdin: async () => {
    const chunks: Uint8Array[] = [];
    for await (const chunk of process.stdin) chunks.push(z.instanceof(Uint8Array).parse(chunk));
    return Buffer.concat(chunks);
  },
  stdout: (text) => {
    process.stdout.write(text);
  },
  stderr: (text) => {
    process.stderr.write(text);
  },
});
