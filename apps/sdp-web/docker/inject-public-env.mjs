import fs from "node:fs";
import path from "node:path";

const targetDirs = process.argv.slice(2);
if (targetDirs.length === 0) {
  console.error("inject-public-env: at least one target directory is required");
  process.exit(1);
}

// Skip the full tree walk on container restarts — the first run creates a
// marker after successfully rewriting placeholders. On subsequent starts the
// bundle already contains concrete values, so there is nothing to replace.
// O_CREAT|O_EXCL is atomic: the open fails with EEXIST if the file is
// already there, avoiding a TOCTOU race between check and create.
const MARKER = path.join(targetDirs[0], ".sdp-env-injected");
let markerFd;
try {
  markerFd = fs.openSync(
    MARKER,
    fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY
  );
} catch (err) {
  if (err.code === "EEXIST") {
    console.log("inject-public-env: already applied (marker exists), skipping");
    process.exit(0);
  }
  throw err;
}

// The URL shape is a valid absolute URL, so its origin survives new URL() /
// `.origin` / path composition at build time and stays swappable at runtime.
const URL_PLACEHOLDER = /https?:\/\/__sdp_rt__([a-z0-9_]+)__\.invalid/g;
const BARE_PLACEHOLDER = /__SDP_RT_([A-Z0-9_]+)__/g;

const unresolved = new Set();

function escapeValue(value) {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/'/g, "\\'")
    .replace(/`/g, "\\`")
    .replace(/[\r\n]+/g, "")
    .replace(/<\/(script)/gi, "<\\/$1");
}

function resolve(varName) {
  if (!varName.startsWith("NEXT_PUBLIC_")) {
    return null;
  }
  const value = process.env[varName];
  if (value === undefined || value === "") {
    unresolved.add(varName);
    return null;
  }
  return escapeValue(value);
}

function* walkFiles(dir) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      yield* walkFiles(full);
    } else if (entry.isFile()) {
      yield full;
    }
  }
}

let rewritten = 0;
for (const dir of targetDirs) {
  for (const file of walkFiles(dir)) {
    let buffer;
    try {
      buffer = fs.readFileSync(file);
    } catch {
      continue;
    }
    if (buffer.includes(0)) {
      continue;
    }
    const content = buffer.toString("utf8");
    if (!content.includes("__sdp_rt__") && !content.includes("__SDP_RT_")) {
      continue;
    }
    const next = content
      .replace(URL_PLACEHOLDER, (match, name) => {
        const value = resolve(name.toUpperCase());
        return value === null ? match : value.replace(/\/+$/, "");
      })
      .replace(BARE_PLACEHOLDER, (match, name) => {
        const value = resolve(name);
        return value === null ? match : value;
      });
    if (next !== content) {
      fs.writeFileSync(file, next);
      rewritten += 1;
    }
  }
}

if (unresolved.size > 0) {
  // Remove the marker so the next restart retries injection instead of
  // silently serving pages with raw __SDP_RT_*__ placeholders.
  fs.closeSync(markerFd);
  fs.unlinkSync(MARKER);
  console.error(
    `inject-public-env: no runtime value for ${[...unresolved].sort().join(", ")}; refusing to start with a broken bundle`
  );
  process.exit(1);
}
fs.writeSync(markerFd, new Date().toISOString());
fs.closeSync(markerFd);
console.log(`inject-public-env: rewrote ${rewritten} file(s)`);
