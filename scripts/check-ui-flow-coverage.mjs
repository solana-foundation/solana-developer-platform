import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

export function auditFlowMatrix({ dashboardDir, specsDir, matrixPath }) {
  const sections = readdirSync(dashboardDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);

  const specs = new Set(readdirSync(specsDir).filter((name) => name.endsWith(".e2e.spec.ts")));

  const rows = readFileSync(matrixPath, "utf8")
    .split("\n")
    .filter((line) => line.startsWith("|"))
    .map((line) => line.split("|").map((cell) => cell.trim()))
    .filter((cells) => cells.length >= 4 && cells[1] !== "Section" && !/^-+$/.test(cells[1]))
    .map((cells) => ({ section: cells[1], spec: cells[3] }));

  const problems = [];
  const rowSections = new Set();
  for (const row of rows) {
    if (rowSections.has(row.section)) {
      problems.push(`matrix has duplicate rows for section "${row.section}"`);
    }
    rowSections.add(row.section);
  }

  for (const section of sections) {
    if (!rowSections.has(section)) {
      problems.push(`dashboard section "${section}" has no row in the UI flow matrix`);
    }
  }

  for (const row of rows) {
    if (!sections.includes(row.section)) {
      problems.push(`matrix row "${row.section}" does not match any dashboard section`);
    }
    if (row.spec === "GAP") {
      continue;
    }
    for (const spec of row.spec.split(",").map((name) => name.trim())) {
      if (!specs.has(spec)) {
        problems.push(`matrix row "${row.section}" references missing spec "${spec}"`);
      }
    }
  }

  return problems;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const root = path.resolve(import.meta.dirname, "..");
  const problems = auditFlowMatrix({
    dashboardDir: path.join(root, "apps/sdp-web/src/app/dashboard"),
    specsDir: path.join(root, "apps/sdp-web/playwright/tests"),
    matrixPath: path.join(root, "docs/testing/ui-flow-matrix.md"),
  });
  if (problems.length > 0) {
    for (const problem of problems) {
      console.error(problem);
    }
    console.error("Update docs/testing/ui-flow-matrix.md to match the dashboard routes.");
    process.exit(1);
  }
  console.log("UI flow matrix matches the dashboard routes.");
}
