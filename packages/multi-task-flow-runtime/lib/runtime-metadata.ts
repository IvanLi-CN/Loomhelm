import { readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import type { ReleaseManifest, ServiceConfig } from "./service-contract";

export const VIEWER_PROVENANCE_SCRIPT_ID = "loomhelm-viewer-provenance";
export const VIEWER_PROVENANCE_SCHEMA_VERSION = 1;
export const ARTIFACT_BUILD_ID_PLACEHOLDER = "__LOOMHELM_ARTIFACT_BUILD_ID__";
export const RUNTIME_IDENTITY_MISMATCH_WARNING =
  "静态 Viewer 与 Daemon 身份不一致，当前网页来源需要核对。";

const exactSemVer =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;
const compatibilityLine = /^compat-v[1-9]\d*$/;
const sha1 = /^[a-f0-9]{40}$/;
const sha256 = /^[a-f0-9]{64}$/;
const buildId = z
  .string()
  .refine((value) => value === ARTIFACT_BUILD_ID_PLACEHOLDER || sha256.test(value));

export const staticViewerProvenanceSchema = z
  .object({
    schema_version: z.literal(VIEWER_PROVENANCE_SCHEMA_VERSION),
    source: z.enum(["package", "legacy-bundle", "custom-view", "source-preview", "unknown"]),
    package_name: z.string().min(1).nullable(),
    package_version: z
      .string()
      .refine((value) => exactSemVer.test(value))
      .nullable(),
    compatibility_line: z
      .string()
      .refine((value) => compatibilityLine.test(value))
      .nullable(),
    skill_version: z
      .string()
      .refine((value) => exactSemVer.test(value))
      .nullable(),
    viewer_contract: z.number().int().positive().nullable(),
    build_id: buildId.nullable(),
    source_sha: z
      .string()
      .refine((value) => sha1.test(value))
      .nullable(),
  })
  .strict();
export type StaticViewerProvenance = z.infer<typeof staticViewerProvenanceSchema>;

export const daemonRuntimeIdentitySchema = z
  .object({
    package_name: z.string().min(1).nullable(),
    package_version: z
      .string()
      .refine((value) => exactSemVer.test(value))
      .nullable(),
    compatibility_line: z
      .string()
      .refine((value) => compatibilityLine.test(value))
      .nullable(),
    skill_version: z
      .string()
      .refine((value) => exactSemVer.test(value))
      .nullable(),
    viewer_contract: z.number().int().positive().nullable(),
    service_contract: z.string().min(1).nullable(),
    build_id: z.string().regex(sha256).nullable(),
    source_sha: z.string().regex(sha1).nullable(),
  })
  .strict();
export type DaemonRuntimeIdentity = z.infer<typeof daemonRuntimeIdentitySchema>;

export const runtimeMetadataSchema = z
  .object({
    static_viewer: staticViewerProvenanceSchema,
    daemon: daemonRuntimeIdentitySchema,
    warning: z.string().min(1).nullable(),
  })
  .strict();
export type RuntimeMetadata = z.infer<typeof runtimeMetadataSchema>;

export function unknownStaticViewerProvenance(
  source: StaticViewerProvenance["source"] = "unknown",
): StaticViewerProvenance {
  return {
    schema_version: VIEWER_PROVENANCE_SCHEMA_VERSION,
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

function normalizeStaticViewerProvenance(value: StaticViewerProvenance): StaticViewerProvenance {
  const trustedSource = value.source === "package" || value.source === "legacy-bundle";
  const incomplete = [
    value.package_name,
    value.package_version,
    value.compatibility_line,
    value.skill_version,
    value.viewer_contract,
    value.build_id,
    value.source_sha,
  ].some((field) => field === null);
  if (value.build_id === ARTIFACT_BUILD_ID_PLACEHOLDER) return { ...value, build_id: null };
  return trustedSource && incomplete ? unknownStaticViewerProvenance() : value;
}

type RuntimeConfig = Pick<
  ServiceConfig,
  | "current_build"
  | "package_name"
  | "package_version"
  | "compatibility_line"
  | "skill_version"
  | "service_contract"
  | "viewer_contract"
  | "source_sha"
  | "artifact_build_id"
>;
type RuntimeManifest = Pick<
  ReleaseManifest,
  "build_id" | "skill_version" | "viewer_contract" | "service_version" | "source_sha"
>;

function hydrateStaticViewerProvenance(
  value: StaticViewerProvenance,
  manifest: RuntimeManifest,
): StaticViewerProvenance {
  const canHydrateBuildId =
    value.build_id === null &&
    (value.source === "package" || value.source === "legacy-bundle") &&
    [
      value.package_name,
      value.package_version,
      value.compatibility_line,
      value.skill_version,
      value.viewer_contract,
      value.source_sha,
    ].every((field) => field !== null);
  return canHydrateBuildId ? { ...value, build_id: manifest.build_id } : value;
}

export function parseViewerProvenanceHtml(html: string): StaticViewerProvenance {
  const marker = `<script id="${VIEWER_PROVENANCE_SCRIPT_ID}" type="application/json">`;
  if (html.split(marker).length !== 2) return unknownStaticViewerProvenance();
  const start = html.indexOf(marker);
  if (start < 0) return unknownStaticViewerProvenance();
  const bodyStart = start + marker.length;
  const end = html.indexOf("</script>", bodyStart);
  if (end < 0 || end - bodyStart > 8192) return unknownStaticViewerProvenance();
  try {
    const value = staticViewerProvenanceSchema.parse(JSON.parse(html.slice(bodyStart, end)));
    return normalizeStaticViewerProvenance(value);
  } catch {
    return unknownStaticViewerProvenance();
  }
}

export function readViewerProvenance(
  assetsDir: string,
  sourceOverride?: StaticViewerProvenance["source"],
): StaticViewerProvenance {
  try {
    if (sourceOverride) return unknownStaticViewerProvenance(sourceOverride);
    return parseViewerProvenanceHtml(readFileSync(join(assetsDir, "index.html"), "utf8"));
  } catch {
    return unknownStaticViewerProvenance(sourceOverride);
  }
}

export function serializeViewerProvenance(provenance: StaticViewerProvenance): string {
  const body = JSON.stringify(provenance).replaceAll("<", "\\u003c");
  return `<script id="${VIEWER_PROVENANCE_SCRIPT_ID}" type="application/json">${body}</script>`;
}

export function daemonRuntimeIdentity(
  config: RuntimeConfig,
  manifest: RuntimeManifest,
): DaemonRuntimeIdentity {
  return daemonRuntimeIdentitySchema.parse({
    package_name: config.package_name ?? null,
    package_version: config.package_version ?? null,
    compatibility_line: config.compatibility_line ?? null,
    skill_version: config.skill_version ?? manifest.skill_version ?? null,
    viewer_contract: config.viewer_contract ?? manifest.viewer_contract ?? null,
    service_contract: config.service_contract ?? manifest.service_version ?? null,
    build_id: config.artifact_build_id ?? config.current_build ?? null,
    source_sha: config.source_sha ?? manifest.source_sha ?? null,
  });
}

export function runtimeIdentityWarning(
  staticViewer: StaticViewerProvenance,
  daemon: DaemonRuntimeIdentity,
): string | null {
  const comparable: (keyof Pick<
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
  for (const key of comparable) {
    const left = staticViewer[key];
    const right = daemon[key];
    if (left !== null && right !== null && left !== right) return RUNTIME_IDENTITY_MISMATCH_WARNING;
  }
  return null;
}

export function runtimeMetadataFromViewer(
  staticViewer: StaticViewerProvenance,
  config: RuntimeConfig,
  manifest: RuntimeManifest,
  warning: string | null = null,
): RuntimeMetadata {
  const hydratedStaticViewer = hydrateStaticViewerProvenance(staticViewer, manifest);
  const daemon = daemonRuntimeIdentity(config, manifest);
  return runtimeMetadataSchema.parse({
    static_viewer: hydratedStaticViewer,
    daemon,
    warning:
      [warning, runtimeIdentityWarning(hydratedStaticViewer, daemon)]
        .filter((value): value is string => Boolean(value))
        .join(" ") || null,
  });
}

export function runtimeMetadata(
  assetsDir: string,
  config: RuntimeConfig,
  manifest: RuntimeManifest,
  warning: string | null = null,
  sourceOverride?: StaticViewerProvenance["source"],
): RuntimeMetadata {
  return runtimeMetadataFromViewer(
    readViewerProvenance(assetsDir, sourceOverride),
    config,
    manifest,
    warning,
  );
}
