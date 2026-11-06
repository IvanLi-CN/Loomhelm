import { sha256Bytes } from "../../modules/flow/common";
import { pathUnderRoot } from "./baseline_paths";
import { readRegularBytesNoFollow } from "./baseline_io";

export function regularBytes(
  path: string,
  stopAt?: string,
): Uint8Array | undefined {
  return readRegularBytesNoFollow(path, stopAt);
}

export function readVerifiedLog(
  resultsRoot: string,
  verboseRoot: string,
  file: string,
  expectedDigest: string | undefined,
): string {
  const resultBytes = regularBytes(
    pathUnderRoot(resultsRoot, file),
    resultsRoot,
  );
  const verboseBytes = regularBytes(
    pathUnderRoot(verboseRoot, file),
    verboseRoot,
  );
  if (!resultBytes || !verboseBytes)
    throw new Error(`baseline log is missing from one run directory: ${file}`);
  const resultDigest = sha256Bytes(resultBytes);
  const verboseDigest = sha256Bytes(verboseBytes);
  if (
    !expectedDigest ||
    resultDigest !== expectedDigest ||
    verboseDigest !== expectedDigest ||
    resultDigest !== verboseDigest
  )
    throw new Error(`baseline log content digest mismatch: ${file}`);
  return Buffer.from(verboseBytes).toString("utf8");
}
