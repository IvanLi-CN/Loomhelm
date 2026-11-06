import { useEffect, useState } from "react";

import type { Artifact } from "@loomhelm/protocol";

import type { ArtifactMetadataLoader } from "./api";

const loaderIds = new WeakMap<ArtifactMetadataLoader, number>();
let nextLoaderId = 1;

export type ArtifactMetadataState =
  | { requestKey: string; status: "idle"; artifact?: undefined; error?: undefined }
  | { requestKey: string; status: "loading"; artifact?: Artifact; error?: undefined }
  | { requestKey: string; status: "ready"; artifact: Artifact; error?: undefined }
  | { requestKey: string; status: "error"; artifact?: undefined; error: unknown };

export function artifactMetadataRequestKey(artifactId: string, retryKey = 0, loaderKey = "default"): string {
  return `${artifactId}\u0000${loaderKey}\u0000${retryKey}`;
}

function loaderIdentity(load: ArtifactMetadataLoader): number {
  const existing = loaderIds.get(load);
  if (existing) return existing;
  const identity = nextLoaderId++;
  loaderIds.set(load, identity);
  return identity;
}

export function useArtifactMetadata(artifactId: string, load: ArtifactMetadataLoader, retryKey = 0, loaderKey?: string): ArtifactMetadataState {
  const requestKey = artifactMetadataRequestKey(artifactId, retryKey, `${loaderIdentity(load)}\u0000${loaderKey ?? ""}`);
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
