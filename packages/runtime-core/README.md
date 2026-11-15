# @loomhelm/runtime-core

`@loomhelm/runtime-core` contains the shared Bun runtime primitives used by Loomhelm Skill packages. It is published independently so consumer packages can install the exact runtime support they declare.

The package is released through `.github/workflows/runtime-core-release.yml` using npm Trusted Publishing. A release must use an exact source commit and SemVer; the workflow freezes one tarball, publishes that tarball, reads back the exact npm version, and creates the matching immutable `runtime-core-vX.Y.Z` tag.
