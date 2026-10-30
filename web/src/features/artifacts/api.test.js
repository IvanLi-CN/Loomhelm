import { describe, expect, test } from "bun:test";

import { createArtifactDownloader } from "./api";

const artifact = {
  content_type: "text/markdown",
  created_at: "2026-10-30T08:00:00Z",
  id: "artifact-download-1",
  kind: "file",
  name: "reports/summary.md",
  run_id: "run-download-1",
  session_id: "session-download-1",
  sha256: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  size: 14,
};

function restoreProperty(target, property, descriptor) {
  if (descriptor === undefined) Reflect.deleteProperty(target, property);
  else Object.defineProperty(target, property, descriptor);
}

describe("artifact download API", () => {
  test("streams authorized bytes into a browser download", async () => {
    const calls = [];
    const links = [];
    const revokedObjectUrls = [];
    const previousDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
    const previousCreateObjectURL = Object.getOwnPropertyDescriptor(URL, "createObjectURL");
    const previousRevokeObjectURL = Object.getOwnPropertyDescriptor(URL, "revokeObjectURL");

    try {
      Object.defineProperty(globalThis, "document", {
        configurable: true,
        value: {
          body: { append: (link) => links.push(link) },
          createElement: () => {
            const link = {
              click: () => undefined,
              download: "",
              href: "",
              rel: "",
              remove: () => undefined,
            };
            return link;
          },
        },
      });
      Object.defineProperty(URL, "createObjectURL", {
        configurable: true,
        value: (blob) => {
          expect(blob).toBeInstanceOf(Blob);
          return "blob:artifact-download-1";
        },
      });
      Object.defineProperty(URL, "revokeObjectURL", {
        configurable: true,
        value: (objectUrl) => revokedObjectUrls.push(objectUrl),
      });

      const download = createArtifactDownloader({
        downloadArtifact: async (request) => {
          calls.push(request);
          return new Response(new Uint8Array([35, 32, 83, 117]), { status: 206 });
        },
      });

      await download({ artifact, signal: new AbortController().signal });
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(calls).toEqual([{ artifact_id: artifact.id }]);
      expect(links).toHaveLength(1);
      expect(links[0]).toMatchObject({ download: "summary.md", href: "blob:artifact-download-1", rel: "noopener" });
      expect(revokedObjectUrls).toEqual(["blob:artifact-download-1"]);
    } finally {
      restoreProperty(globalThis, "document", previousDocument);
      restoreProperty(URL, "createObjectURL", previousCreateObjectURL);
      restoreProperty(URL, "revokeObjectURL", previousRevokeObjectURL);
    }
  });

  test("rejects a failed response before creating a browser download", async () => {
    const download = createArtifactDownloader({
      downloadArtifact: async () => new Response("not found", { status: 404 }),
    });

    await expect(download({ artifact, signal: new AbortController().signal })).rejects.toThrow("status 404");
  });
});
