import { dlopen, FFIType } from "bun:ffi";

type RenameLibrary = { symbols: { renameat2: (...args: (number | Uint8Array)[]) => number } };

let renameLibrary: RenameLibrary | undefined;

export function linuxLibraries(): string[] {
  const arch = ({ x64: "x86_64", arm64: "aarch64" } as Record<string, string>)[
    process.arch
  ];
  return ["libc.so.6", ...(arch ? [`libc.musl-${arch}.so.1`] : []), "libc.so"];
}

export function loadRenameAt2(): (...args: (number | Uint8Array)[]) => number {
  if (renameLibrary) return renameLibrary.symbols.renameat2;
  for (const library of linuxLibraries()) {
    try {
      renameLibrary = dlopen(library, {
        renameat2: {
          args: [
            FFIType.i32,
            FFIType.ptr,
            FFIType.i32,
            FFIType.ptr,
            FFIType.u32,
          ],
          returns: FFIType.i32,
        },
      }) as unknown as RenameLibrary;
      return renameLibrary.symbols.renameat2;
    } catch {}
  }
  throw new Error("native no-replace rename is unavailable");
}
