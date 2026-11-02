import { constants } from "node:fs";
import { access, lstat, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { JsonObject, Operation } from "./contract";
import { CliError, usageError } from "./errors";

/** Refuse unusable destinations before making a billed lookup request. */
export async function prepareBinaryOutput(
  operation: Operation,
  filename: string | undefined
): Promise<string | null> {
  if (Object.keys(operation.binaryResponses).length === 0) return null;
  if (filename === undefined || filename.trim() === "" || filename === "-")
    usageError("This command requires --output with a file path.");
  const destination = resolve(filename);
  try {
    await lstat(destination);
  } catch (cause) {
    if (!(cause instanceof Error && "code" in cause && cause.code === "ENOENT"))
      usageError("Cannot inspect the output path.");
    try {
      await access(dirname(destination), constants.W_OK);
    } catch {
      usageError("The output directory must exist and be writable.");
    }
    return destination;
  }
  return usageError("Output path already exists; choose a new file.");
}

/** wx also protects a destination created after the preflight check. */
export async function saveBinaryOutput(
  destination: string,
  bytes: Uint8Array
): Promise<JsonObject> {
  try {
    await writeFile(destination, bytes, { flag: "wx" });
  } catch {
    throw new CliError(
      "Could not save the output file; an existing file is never overwritten.",
      "OUTPUT_ERROR",
      1
    );
  }
  return { path: destination, contentType: "image/png", bytesWritten: bytes.byteLength };
}
