import { writeSync } from "node:fs";

export function writeAll(fd: number, bytes: Uint8Array, message: string): void {
  let offset = 0;
  while (offset < bytes.byteLength) {
    const written = writeSync(fd, bytes, offset, bytes.byteLength - offset);
    if (written <= 0) throw new Error(message);
    offset += written;
  }
}
