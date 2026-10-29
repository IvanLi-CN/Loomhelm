import { useEffect, useState } from "react";

import type { Artifact } from "@loomhelm/protocol";

import type { ArtifactMetadataLoader } from "./api";

export type ArtifactMetadataState =
  | { requestKey: string; status: "idle"; artifact?: undefined; error?: undefined }
  | { requestKey: string; status: "loading"; artifact?: Artifact; error?: undefined }
  | { requestKey: string; status: "ready"; artifact: Artifact; error?: undefined }
  | { requestKey: string; status: "error"; artifact?: undefined; error: unknown };

export function useArtifactMetadata(artifactId: string, load: ArtifactMetadataLoader, retryKey = 0): ArtifactMetadataState {
  const requestKey = `${artifactId}\u0000${retryKey}`;
  const [state, setState] = useState<ArtifactMetadataState>({ requestKey, status: "idle" });

  useEffect(() => {
    let active = true;
    setState({ requestKey, status: "loading" });
    void load(artifactId).then(
      (artifact) => {
        if (active) setState({ requestKey, status: "ready", artifact });
      },
      (error: unknown) => {
        if (active) setState({ requestKey, status: "error", error });
      }
    );
    return () => {
      active = false;
    };
  }, [artifactId, load, requestKey]);

  return state.requestKey === requestKey ? state : { requestKey, status: "loading" };
}
