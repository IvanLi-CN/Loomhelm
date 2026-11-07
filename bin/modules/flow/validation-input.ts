import { FlowError, stableHash } from "./common";

export function normalizeInputPaths(paths: string[]): string[] {
  return [...new Set(paths.map((path) => path.trim().replace(/^(\.\/)+/, "")))]
    .map((path) => {
      if (!path || path.startsWith("/") || path.split("/").includes(".."))
        throw new FlowError(
          "validation input paths must be repository-relative without '..'",
        );
      return path;
    })
    .sort();
}

export function validationProofKey(
  command: string,
  toolchain: string,
  declaredInput: string,
  paths: string[],
): string {
  return stableHash({
    kind: "validation",
    command,
    toolchain,
    declared_input_scope: declaredInput,
    declared_input_paths: normalizeInputPaths(paths),
  });
}
