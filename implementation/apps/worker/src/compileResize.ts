import { spawnSync } from "node:child_process";
import { isAbsolute, resolve } from "node:path";
import { readdirSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { WorkspaceParametersSchema } from "@canvas/contracts";
import { contentHash, type PreparedRun, type CompilerPin } from "../../api/src/workspacePrototype.ts";

export function recordedCompilerPin(root: string): CompilerPin {
  const sha = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
  const sourceRoot = resolve(root, "vendor/workflow-architect/workflow_architect");
  function files(directory: string, prefix = ""): { path: string; sha256: string }[] {
    return readdirSync(directory, { withFileTypes: true }).sort((a,b) => a.name.localeCompare(b.name)).flatMap(e => {
      const path = prefix + e.name;
      if (e.name === "__pycache__" || e.name.endsWith(".pyc")) return [];
      return e.isDirectory() ? files(resolve(directory, e.name), path + "/") : [{ path, sha256: sha(readFileSync(resolve(directory, e.name))) }];
    });
  }
  return { version: "2.15.2", sourceTreeSha256: contentHash(files(sourceRoot)),
    registrySha256: sha(readFileSync(resolve(root, "tests/fixtures/comfy/object-info-recorded.json"))),
    registryKind: "recorded-fixture-not-live" };
}

/** Explicit offline proof entry, never reachable from the daily worker queue. */
export function compilePreparedResize(run: PreparedRun, options: { pythonExecutable: string; root: string }) {
  if (!isAbsolute(options.pythonExecutable)) throw new Error("EXPLICIT_PYTHON_REQUIRED");
  if (run.state !== "prepared_not_submitted" || run.executionAuthorized !== false || contentHash(run.snapshot) !== run.snapshotHash) {
    throw new Error("INVALID_SNAPSHOT");
  }
  if (contentHash(run.snapshot.compilerPin) !== contentHash(recordedCompilerPin(options.root))) throw new Error("COMPILER_ENVIRONMENT_CHANGED");
  const parameters = WorkspaceParametersSchema.parse(run.snapshot.parameters);
  const result = spawnSync(options.pythonExecutable, ["-B", resolve(options.root, "tools/compile_resize.py")], {
    input: JSON.stringify({ parameters, asset_version_id: run.snapshot.binding.asset.id,
      asset_sha256: run.snapshot.binding.asset.sha256, snapshot_hash: run.snapshotHash, source_image: "owned-probe.png" }),
    encoding: "utf8", timeout: 10_000, maxBuffer: 2 * 1024 * 1024,
    windowsHide: true, shell: false,
  });
  if (result.error || result.status !== 0) throw new Error(`COMPILE_FAILED: ${result.error?.message ?? result.stderr.slice(0, 300)}`);
  const output = JSON.parse(result.stdout);
  if (output.submitted !== false || output.execution_authorized !== false || output.provenance?.snapshot_hash !== run.snapshotHash || !output.validation?.valid) {
    throw new Error("INVALID_COMPILER_OUTPUT");
  }
  return output;
}
