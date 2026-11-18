#!/usr/bin/env -S bun --no-install
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { sourceResources } from "../lib/source-resources.ts";

const root = resolve(import.meta.dirname, "../../..");
const target = resolve(root, "clients/typescript/resources");
const manifest = sourceResources(root);
const packageMetadata = JSON.parse(
  readFileSync(resolve(root, "clients/typescript/package.json"), "utf8"),
);
const packageConfig = packageMetadata.loomhelm;
const requireDependencies = process.argv.includes("--require-dependencies");
const productPartitionBuild = Boolean(process.env.LOOMHELM_PRODUCT_BUILD_VERSION?.trim());
const productBuildVersion = process.env.LOOMHELM_PRODUCT_BUILD_VERSION?.trim() || null;
const exactSemver =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;
const compatibilityLine = /^compat-v([1-9]\d*)$/;
const sha1 = /^[a-f0-9]{40}$/;
const sha256 = /^[a-f0-9]{64}$/;
const packageOmissions = [
  {
    path: "skills/multi-task-flow/.gitignore",
    reason: "package-root .gitignore is omitted by npm-compatible package archives",
  },
  {
    path: "skills/multi-task-flow/data/.gitignore",
    reason: "nested .gitignore is omitted by npm-compatible package archives",
  },
  {
    path: "AGENTS.md",
    reason: "repository instructions are package metadata, not a runtime Skill resource",
  },
  {
    path: "package.json",
    reason: "generated toolkit metadata is validated as package metadata, not a Skill resource",
  },
  {
    path: "artifact-manifest.json",
    reason: "the artifact manifest validates itself through identity and inventory checks",
  },
  {
    path: "skills/multi-task-flow/package.json",
    reason: "source workspace metadata is not part of the consumer runtime",
  },
  {
    path: "skills/multi-task-flow/bun.lock",
    reason: "source workspace lockfile is not part of the consumer runtime",
  },
];
const packageOmissionPaths = new Set(packageOmissions.map((item) => item.path));
const packagedSkill = "multi-task-flow";
const developmentDirectories = ["/tests/", "/examples/"];
const developmentScripts = new Set([
  "build.ts",
  "build-gateway-ui.ts",
  "build-service.ts",
  "catalog-client-skills.ts",
  "check-client-skills.ts",
  "demo-static.ts",
  "diagnose-candidate-sandbox.ts",
  "package-client-skills.ts",
  "preview-source.ts",
  "preview-gateway-recovery.ts",
  "export-gateway-recovery.ts",
  "test-skills-artifact.ts",
  "test-skills-native.ts",
  "test-viewer-source.ts",
  "verify-service-browser.ts",
  "verify-service-native.ts",
  "verify-skills-modules.ts",
]);
const isPackagedResource = (path: string): boolean =>
  path === `skills/${packagedSkill}` || path.startsWith(`skills/${packagedSkill}/`);
const isRuntimeResource = (path: string): boolean =>
  isPackagedResource(path) &&
  !developmentDirectories.some((directory) => path.includes(directory)) &&
  !(
    path.startsWith(`skills/${packagedSkill}/scripts/`) &&
    developmentScripts.has(path.split("/").at(-1)!)
  );
const packagedResources = (values: { path: string; [key: string]: unknown }[]) =>
  values.filter((file) => isPackagedResource(file.path));
const safeSemver = (value: unknown): value is string => {
  if (typeof value !== "string" || !exactSemver.test(value)) return false;
  const [major, minor, patch] = value.split("-", 1)[0]!.split(".").map(Number);
  return (
    [major, minor, patch].every(Number.isSafeInteger) &&
    !value
      .split("-")[1]
      ?.split(".")
      .some((part) => /^0\d+$/.test(part))
  );
};
const buildVersion = productBuildVersion ?? packageMetadata.version;
if (
  packageMetadata.name !== "@loomhelm/multi-task-flow" ||
  !safeSemver(packageMetadata.version) ||
  !safeSemver(buildVersion) ||
  !packageConfig ||
  typeof packageConfig.compatibilityLine !== "string" ||
  !compatibilityLine.test(packageConfig.compatibilityLine) ||
  typeof packageConfig.skillVersion !== "string" ||
  !safeSemver(packageConfig.skillVersion)
)
  throw new Error("Package name/version/metadata must be explicit and valid");
const packageContracts = packageConfig.contracts;
if (
  !packageContracts ||
  typeof packageContracts.ledger !== "number" ||
  !Number.isSafeInteger(packageContracts.ledger) ||
  packageContracts.ledger < 1 ||
  typeof packageContracts.api !== "number" ||
  !Number.isSafeInteger(packageContracts.api) ||
  packageContracts.api < 1 ||
  typeof packageContracts.frontend !== "number" ||
  !Number.isSafeInteger(packageContracts.frontend) ||
  packageContracts.frontend < 1 ||
  typeof packageContracts.viewer !== "number" ||
  !Number.isSafeInteger(packageContracts.viewer) ||
  packageContracts.viewer < 1 ||
  typeof packageContracts.service !== "string" ||
  !packageContracts.service
)
  throw new Error("Package contract metadata is incomplete");
const git = (...args: string[]) =>
  execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim();
const sourceSha = git("rev-parse", "HEAD");
const dirty = Boolean(git("status", "--porcelain"));
if (!sha1.test(sourceSha)) throw new Error("Git source SHA is not a full commit SHA");
const mergeShaValue = process.env.LOOMHELM_MERGE_SHA?.trim() || null;
if (mergeShaValue !== null && !sha1.test(mergeShaValue))
  throw new Error("LOOMHELM_MERGE_SHA must be a full commit SHA");
if (
  process.env.LOOMHELM_REQUIRE_MERGE_SHA === "1" &&
  (dirty || mergeShaValue === null || mergeShaValue !== sourceSha)
)
  throw new Error("Release package builds require a clean checkout at the exact merge SHA");
const gitTag = process.env.LOOMHELM_GIT_TAG?.trim() || null;
if (gitTag !== null && gitTag !== `multi-task-flow-v${buildVersion}`)
  throw new Error("LOOMHELM_GIT_TAG does not match package version");
const tarballDigest = process.env.LOOMHELM_TARBALL_DIGEST?.trim() || null;
if (tarballDigest !== null && !sha256.test(tarballDigest))
  throw new Error("LOOMHELM_TARBALL_DIGEST must be a SHA-256 digest");
type ConsumerDependency = { name: string; version: string; mode: "consumer-install" };
const runtimeDependencyNames = ["@loomhelm/runtime-core", "playwright", "sharp", "zod"] as const;
const declaredDependencies = packageMetadata.dependencies as Record<string, string> | undefined;
if (
  !declaredDependencies ||
  JSON.stringify(Object.keys(declaredDependencies).sort()) !==
    JSON.stringify([...runtimeDependencyNames].sort())
)
  throw new Error(
    "Package production dependencies must be exactly @loomhelm/runtime-core, playwright, sharp, and zod",
  );
const requiredDependencies: ConsumerDependency[] = runtimeDependencyNames.map((name) => {
  const version = declaredDependencies[name];
  if (typeof version !== "string" || !version)
    throw new Error(`Missing runtime dependency declaration: ${name}`);
  return { name, version, mode: "consumer-install" };
});
// Only this exact disposable resource output is replaced. TS is never emitted.
if (existsSync(target)) {
  if (lstatSync(target).isSymbolicLink() || realpathSync(target) !== target)
    throw new Error("Unsafe toolkit output directory");
  rmSync(target, { recursive: true });
}
const outputs = new Map<string, { path: string; sha256: string }>();
function record(path: string, contents: Uint8Array): void {
  outputs.set(path, { path, sha256: createHash("sha256").update(contents).digest("hex") });
}
function copy(
  path: string,
  expected: string | undefined,
  dependency = false,
  sourcePath = path,
): void {
  const source = resolve(root, sourcePath);
  const allowedSourceRoots = [
    resolve(root, "skills") + "/",
    resolve(root, "packages/multi-task-flow-runtime") + "/",
    resolve(root, "docs/specs/multi-task-flow-unified-atomic-orchestration") + "/",
  ];
  if (
    !path.startsWith("skills/") ||
    !allowedSourceRoots.some((prefix) => source.startsWith(prefix))
  )
    throw new Error("Unsafe toolkit resource path");
  const stat = lstatSync(source);
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    (!dependency && stat.nlink !== 1) ||
    realpathSync(source) !== source
  )
    throw new Error("Unsafe toolkit resource: " + path);
  const contents = readFileSync(source);
  const digest = createHash("sha256").update(contents).digest("hex");
  if (expected && digest !== expected)
    throw new Error("Toolkit resource checksum mismatch: " + path);
  const packagedContents = contents;
  const output = resolve(target, path);
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, packagedContents);
  record(path, packagedContents);
}
function writeGenerated(path: string, contents: Uint8Array): void {
  const output = resolve(target, path);
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, contents);
  record(path, contents);
}
function validateInstalledDependencies(): void {
  const packageRoot = resolve(root, "clients/typescript");
  for (const dependency of requiredDependencies) {
    const dependencyRoot = resolve(packageRoot, "node_modules", dependency.name);
    const dependencyManifest = resolve(dependencyRoot, "package.json");
    if (
      !existsSync(dependencyManifest) ||
      lstatSync(dependencyRoot).isSymbolicLink() ||
      realpathSync(dependencyRoot) !== dependencyRoot
    )
      throw new Error(`Consumer dependency is not installed: ${dependency.name}`);
    const metadata = JSON.parse(readFileSync(dependencyManifest, "utf8")) as {
      name?: string;
      version?: string;
    };
    if (metadata.name !== dependency.name || metadata.version !== dependency.version)
      throw new Error(`Consumer dependency version mismatch: ${dependency.name}`);
  }
}
function copyPackageManifest(): void {
  const files = packagedResources(
    manifest.files.filter(
      (file) => !packageOmissionPaths.has(file.path) && isRuntimeResource(file.path),
    ),
  );
  const packageManifest = {
    schemaVersion: 1,
    skills: [packagedSkill],
    files: files.map((file) => ({
      path: file.path,
      installedSha256: outputs.get(file.path)!.sha256,
    })),
    packageOmissions,
  };
  writeGenerated(
    "skills/resource-manifest.json",
    Buffer.from(JSON.stringify(packageManifest, null, 2) + "\n"),
  );
}
function writeToolkitPackageMetadata(): void {
  const metadata = {
    name: packageMetadata.name,
    version: buildVersion,
    description: packageMetadata.description,
    type: packageMetadata.type,
    engines: packageMetadata.engines,
    loomhelm: packageConfig,
    dependencies: declaredDependencies,
    packageManager: packageMetadata.packageManager,
  };
  writeFileSync(resolve(target, "package.json"), JSON.stringify(metadata, null, 2) + "\n");
}
for (const file of packagedResources(
  manifest.files.filter(
    (file) => !packageOmissionPaths.has(file.path) && isRuntimeResource(file.path),
  ),
))
  copy(file.path, undefined, false, file.sourcePath ?? file.path);
copyPackageManifest();
writeToolkitPackageMetadata();
writeGenerated(
  "skills/multi-task-flow/lib/flow-domain-schemas.json",
  readFileSync(resolve(root, "packages/multi-task-flow-runtime/lib/flow-domain-schemas.json")),
);
for (const name of ["index.html", "app.js", "app.css"])
  copy(
    `skills/multi-task-flow/dist/${name}`,
    undefined,
    false,
    `packages/multi-task-flow-runtime/dist/${name}`,
  );
const catalog = JSON.parse(readFileSync(resolve(root, "skills/catalog.json"), "utf8"));
const packagedCatalog = {
  ...catalog,
  entries: catalog.entries
    .filter((entry: { name: string }) => entry.name === packagedSkill)
    .map((entry: { files?: number; scripts?: string[]; [key: string]: unknown }) => ({
      ...entry,
      files: outputs.size,
      ...(entry.scripts ? { scripts: entry.scripts.filter(isRuntimeResource) } : {}),
    })),
};
writeGenerated("skills/catalog.json", Buffer.from(JSON.stringify(packagedCatalog, null, 2) + "\n"));
if (requireDependencies) validateInstalledDependencies();
const packageIdentityBase = {
  packageName: packageMetadata.name,
  packageVersion: buildVersion,
  compatibilityLine: packageConfig.compatibilityLine,
  skillVersion: packageConfig.skillVersion,
  sourceSha,
  mergeSha: productPartitionBuild ? (mergeShaValue ?? sourceSha) : mergeShaValue,
  dirty,
  contracts: {
    ledgerContract: packageContracts.ledger,
    apiVersion: packageContracts.api,
    frontendContract: packageContracts.frontend,
    viewerContract: packageContracts.viewer,
    serviceVersion: packageContracts.service,
  },
  tarballDigest,
  gitTag,
  canonicalDigestAlgorithm: "path-byte-v2",
};
// Build identity must be independent of the runner's process locale.
const finalInventory = [...outputs.values()].sort((left, right) =>
  left.path < right.path ? -1 : left.path > right.path ? 1 : 0,
);
const buildId = createHash("sha256")
  .update(JSON.stringify({ ...packageIdentityBase, files: finalInventory }))
  .digest("hex");
const identity = { ...packageIdentityBase, buildId };
const artifact = {
  schemaVersion: 3,
  packageName: packageMetadata.name,
  packageVersion: buildVersion,
  compatibilityLine: packageConfig.compatibilityLine,
  skillVersion: packageConfig.skillVersion,
  sourceCommit: sourceSha,
  sourceSha,
  mergeSha: packageIdentityBase.mergeSha,
  candidateSha: sourceSha,
  dirty,
  runtime: "bun@1.4.4",
  identity,
  buildId,
  tarballDigest,
  gitTag,
  canonicalDigestAlgorithm: "path-byte-v2",
  dependenciesBundled: false,
  dependencies: requiredDependencies,
  omittedResources: packageOmissions,
  files: finalInventory,
};
writeFileSync(resolve(target, "artifact-manifest.json"), JSON.stringify(artifact, null, 2) + "\n");
console.log(
  JSON.stringify({
    artifact: target,
    package: packageMetadata.name,
    version: buildVersion,
    compatibilityLine: packageConfig.compatibilityLine,
    runtime: "bun@1.4.4",
    resources: finalInventory.length,
    dependenciesBundled: false,
    dependencies: requiredDependencies,
    source: sourceSha,
    merge: packageIdentityBase.mergeSha,
    buildId,
    dirty,
  }),
);
