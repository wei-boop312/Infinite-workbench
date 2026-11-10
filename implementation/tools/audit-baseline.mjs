import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync } from "node:fs";
import { resolve, join, relative } from "node:path";
import { createHash } from "node:crypto";

const root = process.cwd();
const baseline = "19499e7";
const digest = bytes => createHash("sha256").update(bytes).digest("hex");
const output = resolve(root, "docs/evidence/2026-11-09");
mkdirSync(output, { recursive: true });
const paths = execFileSync("git", ["ls-tree", "-r", "--name-only", baseline], { encoding: "utf8" }).trim().split("\n");
const changedPaths = new Set(execFileSync("git", ["diff", "--name-only", baseline], { encoding: "utf8" }).trim().split("\n"));
const category = path => path.includes(".test.") || path.startsWith("tests/") ? "A/B-test-candidate"
  : path.startsWith("docs/") || path.endsWith(".md") ? "C-reference"
  : path.startsWith("apps/web/") ? "B-view-and-local-storage-migration"
  : path.startsWith("apps/api/") ? "B-server-contract-and-storage-migration"
  : path.startsWith("apps/worker/") ? "B-worker-adapter"
  : path.startsWith("packages/") ? "B-shared-contract-migration"
  : "C-build-and-tooling-reference";
const files = paths.map(path => {
  const original = execFileSync("git", ["show", `${baseline}:${path}`], { maxBuffer: 8 * 1024 * 1024 });
  const current = readFileSync(resolve(root, path));
  return { path, baselineSha256: digest(original), currentSha256: digest(current), changed: changedPaths.has(path),
    checkoutBytesDifferFromBlob: !original.equals(current),
    proposedClassification: category(path), classificationStatus: "inventory-only-not-final-file-review" };
});
const vendorRoot = resolve(root, "vendor/workflow-architect");
function inventory(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap(e => {
    const path = join(directory, e.name);
    return e.isDirectory() ? inventory(path) : [{ path: relative(root, path).replaceAll("\\", "/"), sha256: digest(readFileSync(path)) }];
  });
}
const dependencies = [];
const seen = new Set();
function addPackage(directory) {
  const p = join(directory, "package.json");
  if (!existsSync(p)) return;
  const metadata = JSON.parse(readFileSync(p, "utf8"));
  const key = `${metadata.name}@${metadata.version}`;
  if (seen.has(key)) return; seen.add(key);
  const evidence = readdirSync(directory).filter(name => /^(license|licence|copying|notice)(\.|$|-)/i.test(name));
  dependencies.push({ name: metadata.name, version: metadata.version, declaredLicense: metadata.license ?? null,
    licenseFiles: evidence.map(name => ({ path: relative(root, join(directory, name)).replaceAll("\\", "/"), sha256: digest(readFileSync(join(directory, name))) })),
    status: "INVENTORIED_NOT_APPROVED_FOR_PRODUCTION" });
}
for (const entry of readdirSync(resolve(root, "node_modules/.pnpm"), { withFileTypes: true })) {
  if (!entry.isDirectory() || entry.name === "node_modules") continue;
  const modules = resolve(root, "node_modules/.pnpm", entry.name, "node_modules");
  if (!existsSync(modules)) continue;
  for (const name of readdirSync(modules)) {
    const directory = join(modules, name);
    if (name.startsWith("@")) for (const child of readdirSync(directory)) addPackage(join(directory, child));
    else addPackage(directory);
  }
}
const report = {
  schemaVersion: 1, date: "2026-11-09", baselineCommit: execFileSync("git", ["rev-parse", baseline], { encoding: "utf8" }).trim(),
  source: "C:/Users/MECHREVO/Documents/Codex/2026-09-26/xian-z/work/ai-commerce-canvas",
  originalSourceWorktreeStatus: execFileSync("git", ["-C", "C:/Users/MECHREVO/Documents/Codex/2026-09-26/xian-z/work/ai-commerce-canvas", "status", "--short"], { encoding: "utf8" }).trim(),
  note: "Git compares canonical content; checkout byte hashes can differ from git blobs because of CRLF normalization.",
  licenseReview: "INCOMPLETE", rootLicensePresent: existsSync(join(root, "LICENSE")),
  nodeVersion: process.version, lockSha256: digest(readFileSync(join(root, "pnpm-lock.yaml"))),
  files, vendor: inventory(vendorRoot), dependencies: dependencies.sort((a, b) => a.name.localeCompare(b.name)),
};
writeFileSync(join(output, "baseline-inventory.json"), JSON.stringify(report, null, 2) + "\n");
console.log(JSON.stringify({ baselineFiles: files.length, vendorFiles: report.vendor.length, dependencies: dependencies.length,
  baselineChanged: files.filter(f => f.changed).map(f => f.path), missingLicenseEvidence: dependencies.filter(d => !d.licenseFiles.length).map(d => `${d.name}@${d.version}`) }, null, 2));
