import { useEffect, useState } from "react";

import type { Artifact } from "@loomhelm/protocol";

import type { ArtifactMetadataLoader } from "./api";

export type ArtifactMetadataState =
  | { status: "idle"; artifact?: undefined; error?: undefined }
  | { status: "loading"; artifact?: Artifact; error?: undefined }
  | { status: "ready"; artifact: Artifact; error?: undefined }
  | { status: "error"; artifact?: undefined; error: unknown };

export function useArtifactMetadata(artifactId: string, load: ArtifactMetadataLoader, retryKey = 0): ArtifactMetadataState {
  const [state, setState] = useState<ArtifactMetadataState>({ status: "idle" });

  useEffect(() => {
    let active = true;
    setState({ status: "loading" });
    void load(artifactId).then(
      (artifact) => {
        if (active) setState({ status: "ready", artifact });
      },
      (error: unknown) => {
        if (active) setState({ status: "error", error });
      }
    );
    return () => {
      active = false;
    };
  }, [artifactId, load, retryKey]);

  return state;
}
