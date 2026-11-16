import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  ARTIFACT_BUILD_ID_PLACEHOLDER,
  daemonRuntimeIdentity,
  parseViewerProvenanceHtml,
  RUNTIME_IDENTITY_MISMATCH_WARNING,
  runtimeIdentityWarning,
  runtimeMetadata,
} from "../lib/runtime-metadata";

const staticViewer = {
  schema_version: 1,
  source: "package" as const,
  package_name: "@loomhelm/multi-task-flow",
  package_version: "0.2.23",
  compatibility_line: "compat-v1",
  skill_version: "2.7.10",
  viewer_contract: 5,
  build_id: "b".repeat(64),
  source_sha: "a".repeat(40),
};

test("parses package provenance and normalizes an unfinished build id", () => {
  const html = `<script id="loomhelm-viewer-provenance" type="application/json">${JSON.stringify(staticViewer)}</script>`;
  expect(parseViewerProvenanceHtml(html)).toEqual(staticViewer);
  expect(
    parseViewerProvenanceHtml(
      `<script id="loomhelm-viewer-provenance" type="application/json">${JSON.stringify({ ...staticViewer, build_id: ARTIFACT_BUILD_ID_PLACEHOLDER })}</script>`,
    ),
  ).toEqual({
    schema_version: 1,
    source: "package",
    package_name: "@loomhelm/multi-task-flow",
    package_version: "0.2.23",
    compatibility_line: "compat-v1",
    skill_version: "2.7.10",
    viewer_contract: 5,
    build_id: null,
    source_sha: "a".repeat(40),
  });
  expect(parseViewerProvenanceHtml(html + html).source).toBe("unknown");
  expect(
    parseViewerProvenanceHtml(
      `<script id="loomhelm-viewer-provenance" type="application/json">${JSON.stringify({ ...staticViewer, package_version: null })}</script>`,
    ).source,
  ).toBe("unknown");
  expect(parseViewerProvenanceHtml("<html></html>").source).toBe("unknown");
});

test("builds independent daemon metadata and reports only confirmed identity drift", () => {
  const root = mkdtempSync(join(Bun.env.TMPDIR ?? "/tmp", "loomhelm-runtime-metadata-"));
  try {
    writeFileSync(
      join(root, "index.html"),
      `<script id="loomhelm-viewer-provenance" type="application/json">${JSON.stringify(staticViewer)}</script>`,
    );
    const manifest = {
      build_id: "b".repeat(64),
      skill_version: "2.7.10",
      viewer_contract: 5,
      service_version: "1",
      source_sha: "a".repeat(40),
    };
    const config = {
      package_name: "@loomhelm/multi-task-flow",
      current_build: "b".repeat(64),
      package_version: "0.2.23",
      compatibility_line: "compat-v1",
      skill_version: "2.7.10",
      service_contract: "1",
      viewer_contract: 5,
      source_sha: "a".repeat(40),
      artifact_build_id: "b".repeat(64),
    };
    const runtime = runtimeMetadata(root, config, manifest);
    expect(runtime.warning).toBeNull();
    expect(runtime.static_viewer.build_id).toBe(runtime.daemon.build_id);
    expect(
      daemonRuntimeIdentity({ ...config, artifact_build_id: undefined }, manifest).build_id,
    ).toBe(config.current_build);
    expect(
      runtimeIdentityWarning(runtime.static_viewer, {
        ...runtime.daemon,
        build_id: "c".repeat(64),
      }),
    ).toBe(RUNTIME_IDENTITY_MISMATCH_WARNING);
    expect(
      runtimeMetadata(root, config, manifest, null, "custom-view").static_viewer,
    ).toMatchObject({ source: "custom-view", package_name: null, build_id: null });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("hydrates the build id that is resolved by the release manifest", () => {
  const root = mkdtempSync(join(Bun.env.TMPDIR ?? "/tmp", "loomhelm-runtime-hydration-"));
  try {
    writeFileSync(
      join(root, "index.html"),
      `<script id="loomhelm-viewer-provenance" type="application/json">${JSON.stringify({ ...staticViewer, build_id: ARTIFACT_BUILD_ID_PLACEHOLDER })}</script>`,
    );
    const buildId = "c".repeat(64);
    const runtime = runtimeMetadata(
      root,
      {
        current_build: buildId,
        package_name: staticViewer.package_name,
        package_version: staticViewer.package_version,
        compatibility_line: staticViewer.compatibility_line,
        skill_version: staticViewer.skill_version,
        service_contract: "1",
        viewer_contract: staticViewer.viewer_contract,
        source_sha: staticViewer.source_sha,
      },
      {
        build_id: buildId,
        skill_version: staticViewer.skill_version,
        viewer_contract: staticViewer.viewer_contract,
        service_version: "1",
        source_sha: staticViewer.source_sha,
      },
    );
    expect(runtime.static_viewer.build_id).toBe(buildId);
    expect(runtime.daemon.build_id).toBe(buildId);
    expect(runtime.warning).toBeNull();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
