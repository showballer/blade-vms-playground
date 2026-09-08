import { readFileSync, writeFileSync } from "node:fs";
import ts from "typescript";
import { records } from "./seed-data.mjs";
writeFileSync(
  new URL("../apps/desktop/electron/demo-data.json", import.meta.url),
  JSON.stringify(records, null, 2),
);
// Build the shared validator for the Electron main process; keep a single
// validation source for online and offline task metadata.
for (const name of ["task-metadata", "sync-data", "batch", "import-data", "rotation-data", "modal-data", "signal-input", "result-data", "data-export"]) {
writeFileSync(new URL(`../apps/desktop/electron/${name}.cjs`, import.meta.url),
  ts.transpileModule(readFileSync(new URL(`../packages/ui/src/${name}.ts`, import.meta.url), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText.replace(/require\("\.\/([\w-]+)"\)/g, 'require("./$1.cjs")'));
}
