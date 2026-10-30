import type { GeneratedApiClient } from "@loomhelm/api-client";
import type { Artifact } from "@loomhelm/protocol";

export type ArtifactMetadataLoader = (artifactId: string) => Promise<Artifact>;

export interface ArtifactDownloadRequest {
  artifact: Artifact;
  signal: AbortSignal;
}

export type ArtifactDownloader = (request: ArtifactDownloadRequest) => Promise<void>;

export function createArtifactMetadataLoader(client: Pick<GeneratedApiClient, "getArtifact">): ArtifactMetadataLoader {
  return async (artifactId) => (await client.getArtifact({ artifact_id: artifactId })).artifact;
}

function throwIfArtifactDownloadAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new DOMException("Artifact download was cancelled", "AbortError");
}

function artifactFileName(name: string, id: string): string {
  const basename = name.replaceAll("\\", "/").split("/").at(-1)?.replace(/[\u0000-\u001f\u007f]/g, "").trim();
  return basename || `artifact-${id}`;
}

function startBrowserArtifactDownload(blob: Blob, name: string, id: string): void {
  if (typeof document === "undefined" || typeof URL.createObjectURL !== "function") throw new Error("Artifact downloads require a browser document.");
  const objectUrl = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = objectUrl;
  link.download = artifactFileName(name, id);
  link.rel = "noopener";
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(objectUrl), 0);
}

export function createArtifactDownloader(client: Pick<GeneratedApiClient, "downloadArtifact">): ArtifactDownloader {
  return async ({ artifact, signal }) => {
    throwIfArtifactDownloadAborted(signal);
    const response = await client.downloadArtifact({ artifact_id: artifact.id });
    throwIfArtifactDownloadAborted(signal);
    if (!response.ok) throw new Error(`Artifact download failed with status ${response.status}.`);
    const blob = await response.blob();
    throwIfArtifactDownloadAborted(signal);
    startBrowserArtifactDownload(blob, artifact.name, artifact.id);
  };
}
