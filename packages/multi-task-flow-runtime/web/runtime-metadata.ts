export type RuntimeSource =
  | "package"
  | "legacy-bundle"
  | "custom-view"
  | "source-preview"
  | "unknown";

export type StaticViewerProvenance = {
  schema_version: 1;
  source: RuntimeSource;
  package_name: string | null;
  package_version: string | null;
  compatibility_line: string | null;
  skill_version: string | null;
  viewer_contract: number | null;
  build_id: string | null;
  source_sha: string | null;
};

export type DaemonRuntimeIdentity = {
  package_name: string | null;
  package_version: string | null;
  compatibility_line: string | null;
  skill_version: string | null;
  viewer_contract: number | null;
  service_contract: string | null;
  build_id: string | null;
  source_sha: string | null;
};

export type RuntimeMetadata = {
  static_viewer: StaticViewerProvenance;
  daemon: DaemonRuntimeIdentity;
  warning: string | null;
};

export const RUNTIME_IDENTITY_MISMATCH_WARNING =
  "静态 Viewer 与 Daemon 身份不一致，当前网页来源需要核对。";
const PLACEHOLDER_BUILD_ID = "__LOOMHELM_ARTIFACT_BUILD_ID__";
const exactSemVer =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;
const compatibilityLine = /^compat-v[1-9]\d*$/;
const sha1 = /^[a-f0-9]{40}$/;
const sha256 = /^[a-f0-9]{64}$/;
const sources = new Set<RuntimeSource>([
  "package",
  "legacy-bundle",
  "custom-view",
  "source-preview",
  "unknown",
]);

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function nullableString(value: unknown, pattern?: RegExp): string | null | undefined {
  if (value === null) return null;
  if (typeof value !== "string" || !value || (pattern && !pattern.test(value))) return undefined;
  return value;
}

export function unknownStaticViewerProvenance(
  source: RuntimeSource = "unknown",
): StaticViewerProvenance {
  return {
    schema_version: 1,
    source,
    package_name: null,
    package_version: null,
    compatibility_line: null,
    skill_version: null,
    viewer_contract: null,
    build_id: null,
    source_sha: null,
  };
}

export function unknownDaemonRuntimeIdentity(): DaemonRuntimeIdentity {
  return {
    package_name: null,
    package_version: null,
    compatibility_line: null,
    skill_version: null,
    viewer_contract: null,
    service_contract: null,
    build_id: null,
    source_sha: null,
  };
}

function parseStaticViewer(value: unknown): StaticViewerProvenance | null {
  const raw = record(value);
  if (
    raw?.schema_version !== 1 ||
    typeof raw.source !== "string" ||
    !sources.has(raw.source as RuntimeSource)
  )
    return null;
  const packageName = nullableString(raw.package_name);
  const packageVersion = nullableString(raw.package_version, exactSemVer);
  const compatibility = nullableString(raw.compatibility_line, compatibilityLine);
  const skillVersion = nullableString(raw.skill_version, exactSemVer);
  const sourceSha = nullableString(raw.source_sha, sha1);
  const placeholder = raw.build_id === PLACEHOLDER_BUILD_ID;
  const build =
    raw.build_id === null ? null : placeholder ? null : nullableString(raw.build_id, sha256);
  if (
    packageName === undefined ||
    packageVersion === undefined ||
    compatibility === undefined ||
    skillVersion === undefined ||
    sourceSha === undefined ||
    build === undefined
  )
    return null;
  if (
    raw.viewer_contract !== null &&
    (!Number.isSafeInteger(raw.viewer_contract) || (raw.viewer_contract as number) < 1)
  )
    return null;
  const result = {
    schema_version: 1,
    source: raw.source as RuntimeSource,
    package_name: packageName,
    package_version: packageVersion,
    compatibility_line: compatibility,
    skill_version: skillVersion,
    viewer_contract: raw.viewer_contract as number | null,
    build_id: build,
    source_sha: sourceSha,
  };
  const trustedSource = result.source === "package" || result.source === "legacy-bundle";
  const incomplete = [
    result.package_name,
    result.package_version,
    result.compatibility_line,
    result.skill_version,
    result.viewer_contract,
    result.build_id,
    result.source_sha,
  ].some((field) => field === null);
  return placeholder || (trustedSource && incomplete) ? unknownStaticViewerProvenance() : result;
}

export function readEmbeddedViewerProvenance(document: Document): StaticViewerProvenance {
  const scripts = document.querySelectorAll("script#loomhelm-viewer-provenance");
  if (scripts.length !== 1) return unknownStaticViewerProvenance();
  const script = scripts[0];
  if (!script || script.tagName !== "SCRIPT" || script.getAttribute("type") !== "application/json")
    return unknownStaticViewerProvenance();
  try {
    return (
      parseStaticViewer(JSON.parse(script.textContent ?? "")) ?? unknownStaticViewerProvenance()
    );
  } catch {
    return unknownStaticViewerProvenance();
  }
}

function parseDaemon(value: unknown): DaemonRuntimeIdentity | null {
  const raw = record(value);
  if (!raw) return null;
  const packageName = nullableString(raw.package_name);
  const packageVersion = nullableString(raw.package_version, exactSemVer);
  const compatibility = nullableString(raw.compatibility_line, compatibilityLine);
  const skillVersion = nullableString(raw.skill_version, exactSemVer);
  const serviceContract = nullableString(raw.service_contract);
  const sourceSha = nullableString(raw.source_sha, sha1);
  const build = nullableString(raw.build_id, sha256);
  if (
    packageName === undefined ||
    packageVersion === undefined ||
    compatibility === undefined ||
    skillVersion === undefined ||
    serviceContract === undefined ||
    sourceSha === undefined ||
    build === undefined
  )
    return null;
  if (
    raw.viewer_contract !== null &&
    (!Number.isSafeInteger(raw.viewer_contract) || (raw.viewer_contract as number) < 1)
  )
    return null;
  return {
    package_name: packageName,
    package_version: packageVersion,
    compatibility_line: compatibility,
    skill_version: skillVersion,
    viewer_contract: raw.viewer_contract as number | null,
    service_contract: serviceContract,
    build_id: build,
    source_sha: sourceSha,
  };
}

export function parseRuntimeMetadata(value: unknown): RuntimeMetadata | null {
  const raw = record(value);
  if (!raw) return null;
  const staticViewer = parseStaticViewer(raw.static_viewer);
  const daemon = parseDaemon(raw.daemon);
  if (!staticViewer || !daemon || (raw.warning !== null && typeof raw.warning !== "string"))
    return null;
  return { static_viewer: staticViewer, daemon, warning: raw.warning as string | null };
}

export function runtimeIdentityWarning(runtime: RuntimeMetadata): string | null {
  const keys: (keyof Pick<
    StaticViewerProvenance,
    | "package_name"
    | "package_version"
    | "compatibility_line"
    | "skill_version"
    | "viewer_contract"
    | "build_id"
    | "source_sha"
  >)[] = [
    "package_name",
    "package_version",
    "compatibility_line",
    "skill_version",
    "viewer_contract",
    "build_id",
    "source_sha",
  ];
  for (const key of keys)
    if (
      runtime.static_viewer[key] !== null &&
      runtime.daemon[key] !== null &&
      runtime.static_viewer[key] !== runtime.daemon[key]
    )
      return RUNTIME_IDENTITY_MISMATCH_WARNING;
  return null;
}

export function runtimeWithEmbeddedViewer(
  runtime: RuntimeMetadata | null,
  document: Document,
  options: { trustEmbeddedViewer?: boolean } = {},
): RuntimeMetadata {
  const embedded =
    options.trustEmbeddedViewer === false
      ? unknownStaticViewerProvenance()
      : readEmbeddedViewerProvenance(document);
  if (!runtime)
    return { static_viewer: embedded, daemon: unknownDaemonRuntimeIdentity(), warning: null };
  return runtime;
}
