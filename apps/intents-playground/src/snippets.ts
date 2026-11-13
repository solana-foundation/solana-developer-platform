// The requests of the Intent tab as curl, TypeScript, Rust, and the CLI.

const SERVICE = "http://127.0.0.1:8787";
const RPC = "http://127.0.0.1:8899";

// A single quote ends the shell's quoted string, so each one closes, escapes, and reopens it.
function shellJson(value: object): string {
  return `'${JSON.stringify(value, null, 2).replace(/'/g, "'\\''")}'`;
}

export function prepareSnippets(request: object): Record<string, string> {
  const body = JSON.stringify(request, null, 2);

  return {
    curl: `curl -s ${SERVICE}/v1/prepare \\\n  -H 'content-type: application/json' \\\n  -d ${shellJson(request)}`,
    TypeScript: `const plan = await fetch("${SERVICE}/v1/prepare", {\n  method: "POST",\n  headers: { "content-type": "application/json" },\n  body: JSON.stringify(${body.replace(/\n/g, "\n  ")}),\n}).then((response) => response.json());`,
    Rust: `// sdp-intents prepare plans the same request against RPC, with no service.\nlet request = serde_json::json!(${body});\nlet plan: serde_json::Value = reqwest::blocking::Client::new()\n    .post("${SERVICE}/v1/prepare")\n    .json(&request)\n    .send()?\n    .json()?;`,
  };
}

/// The signer verifies against its own RPC, not against the service that planned the transaction.
/// The TypeScript library runs the Rust client's verifier, compiled to WebAssembly.
function verifySnippets(message: { typescript: string; rust: string }) {
  return {
    TypeScript: `import { Verifier } from "@sdp/intents-verifier";\nimport verifierWasm from "@sdp/intents-verifier/verifier.wasm?url";\n\n// Node passes the module's bytes to \`Verifier.load\`, in place of its URL.\nconst verifier = await Verifier.load(verifierWasm);\n${message.typescript}\nconst verified = await verifier.verifyMessage(message, "${RPC}");\n\nif (verified.message !== plan.message || verified.unverified.length > 0) {\n  throw new Error("the transaction does not prove the plan's message");\n}`,
    Rust: `use base64::Engine as _;\n\nlet client = sdp_intents_client::Client::new("${RPC}");\n${message.rust}\nlet verified = client.verify_message(&message)?;\n\nif verified.message != plan.message || !verified.unverified.is_empty() {\n    return Err("the transaction does not prove the plan's message".into());\n}`,
  };
}

/// A plan of instructions alone: the caller compiles it to a message of any version, then verifies
/// that message.
export function compileSnippets(): Record<string, string> {
  return {
    CLI: `# Compile the instructions as a legacy, v0, or v1 transaction, then verify and send it.\nsdp-intents verify plan.json --rpc ${RPC} --version 0 --lookup-table <table>\nsdp-intents send plan.json --rpc ${RPC} --version 0 --lookup-table <table> --keypair <signer.json>`,
    ...verifySnippets({
      typescript:
        "// The message that the caller compiled, of any version.\nconst message = compiledMessage;",
      rust: "// The message that the caller compiled, of any version.\nlet message = compiled_message;",
    }),
  };
}

export function sendSnippets(compiled: string): Record<string, string> {
  const verify = verifySnippets({
    typescript:
      // biome-ignore lint/security/noSecrets: a code sample, not a secret.
      "const message = Uint8Array.from(atob(plan.transaction.messageBytes), (c) => c.charCodeAt(0));",
    rust: `let message = base64::engine::general_purpose::STANDARD.decode("${compiled.slice(0, 24)}…")?;`,
  });

  return {
    TypeScript: verify.TypeScript,
    Rust: `${verify.Rust}\n\nlet signature = client.send_message(&message, &[&fee_payer, &owner])?;`,
    CLI: `# The client's verifier reads the registry over RPC, with no service.\nsdp-intents verify plan.json --rpc ${RPC}\nsdp-intents send plan.json --rpc ${RPC} --keypair <signer.json>`,
    curl: `# Sign with the service's local wallets and send. Verify first, with one of the other snippets.\ncurl -s ${SERVICE}/v1/send \\\n  -H 'content-type: application/json' \\\n  -d ${shellJson({ message: compiled })}`,
  };
}
