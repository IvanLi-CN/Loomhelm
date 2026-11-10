import { identityDigest, validatePackageIdentity, type PackageIdentity } from './release.ts';
import type { ToolkitArtifactFile, ToolkitArtifactManifest } from './toolkit.ts';

export interface RuntimeBuildInfo {
  package_name: string;
  version: string;
  source_sha: string;
  merge_sha: string | null;
  compatibility_line: string;
  skill_version: string;
  build_id: string;
  tarball_digest: string | null;
  contracts: {
    ledger: number;
    api: number;
    frontend: number;
    viewer: number;
    service: string;
  };
  policy: 'loomhelm-manual-v1';
}

function validatedIdentity(artifact: ToolkitArtifactManifest): PackageIdentity {
  const identity = validatePackageIdentity(artifact.identity);
  if (identity.packageName !== artifact.packageName || identity.packageVersion !== artifact.packageVersion || identity.compatibilityLine !== artifact.compatibilityLine || identity.skillVersion !== artifact.skillVersion || identity.sourceSha !== artifact.sourceSha || identity.mergeSha !== artifact.mergeSha || identity.buildId !== artifact.buildId || identity.tarballDigest !== artifact.tarballDigest || identity.gitTag !== artifact.gitTag) throw new Error('Toolkit artifact identity mismatch');
  const { buildId, ...withoutBuildId } = identity;
  const files = artifact.files as readonly ToolkitArtifactFile[];
  if (identityDigest({ ...withoutBuildId, files }) !== buildId) throw new Error('Toolkit artifact build ID mismatch');
  return identity;
}

export function buildInfoFromArtifact(artifact: ToolkitArtifactManifest): RuntimeBuildInfo {
  const identity = validatedIdentity(artifact);
  return Object.freeze({
    package_name: identity.packageName,
    version: identity.packageVersion,
    source_sha: identity.sourceSha,
    merge_sha: identity.mergeSha,
    compatibility_line: identity.compatibilityLine,
    skill_version: identity.skillVersion,
    build_id: identity.buildId,
    tarball_digest: identity.tarballDigest,
    contracts: {
      ledger: identity.contracts.ledgerContract,
      api: identity.contracts.apiVersion,
      frontend: identity.contracts.frontendContract,
      viewer: identity.contracts.viewerContract,
      service: identity.contracts.serviceVersion,
    },
    policy: 'loomhelm-manual-v1',
  });
}

export function requirePublishableArtifact(artifact: ToolkitArtifactManifest): PackageIdentity {
  const identity = validatedIdentity(artifact);
  if (artifact.dirty) throw new Error('Publication requires a clean toolkit artifact');
  if (identity.mergeSha === null || identity.mergeSha !== artifact.sourceSha) throw new Error('Publication requires artifact merge provenance');
  if (identity.tarballDigest === null) throw new Error('Publication requires tarball provenance');
  if (identity.gitTag !== `multi-task-flow-v${identity.packageVersion}`) throw new Error('Publication requires a matching Git tag provenance');
  return identity;
}
