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

export function createArtifactDownloader(download: ArtifactDownloader): ArtifactDownloader {
  return async ({ artifact, signal }) => {
    if (signal.aborted) throw new DOMException("Artifact download was cancelled", "AbortError");
    await download({ artifact, signal });
  };
}
