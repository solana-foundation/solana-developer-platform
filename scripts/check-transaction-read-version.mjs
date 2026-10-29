import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const sourceRoots = ["apps", "packages"];
const forbidden = /maxSupportedTransactionVersion\s*:\s*0\b/g;
const violations = [];

function checkDirectory(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== "node_modules" && entry.name !== "dist") checkDirectory(path);
    } else if (/\.[cm]?[jt]sx?$/.test(entry.name)) {
      const source = readFileSync(path, "utf8");
      for (const match of source.matchAll(forbidden)) {
        const line = source.slice(0, match.index).split("\n").length;
        violations.push(`${path}:${line}`);
      }
    }
  }
}

for (const root of sourceRoots) checkDirectory(root);

if (violations.length > 0) {
  console.error(`Transaction reads still cap v1:\n${violations.join("\n")}`);
  process.exitCode = 1;
} else {
  console.log("Transaction reads accept v1");
}
