import {
  constants,
  closeSync,
  fchmodSync,
  existsSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
} from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { requireCondition } from "../lib/errors";
import {
  ensureDirectory,
  readRegular,
  syncDirectory,
  withExclusiveLock,
  writeAtomic,
} from "../lib/store";

export const themes = ["system", "light", "dark"] as const;
export type Theme = (typeof themes)[number];
export type Preferences = { schema_version: 1; theme: Theme };

const fallback: Preferences = { schema_version: 1, theme: "system" };

function validTheme(value: unknown): value is Theme {
  return (
    typeof value === "string" && (themes as readonly string[]).includes(value)
  );
}
function parsePreferences(raw: string): Preferences | null {
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return parsed.schema_version === 1 &&
      validTheme(parsed.theme) &&
      Object.keys(parsed).length === 2
      ? { schema_version: 1, theme: parsed.theme }
      : null;
  } catch {
    return null;
  }
}

export class GlobalPreferencesStore {
  readonly path: string;
  readonly lockPath: string;

  constructor(readonly root: string) {
    requireCondition(
      isAbsolute(root),
      "INVALID_ROOT",
      "Data root must be absolute",
    );
    ensureDirectory(root);
    const locks = join(root, "locks");
    ensureDirectory(locks);
    this.path = join(root, "ui-preferences.json");
    this.lockPath = join(locks, "ui-preferences.lock");
    if (!existsSync(this.lockPath)) {
      try {
        const fd = openSync(
          this.lockPath,
          constants.O_WRONLY |
            constants.O_CREAT |
            constants.O_EXCL |
            constants.O_NOFOLLOW,
          0o600,
        );
        closeSync(fd);
      } catch (error) {
        if (!(
          error &&
          typeof error === "object" &&
          "code" in error &&
          error.code === "EEXIST"
        ))
          throw error;
      }
    }
    requireCondition(
      !lstatSync(this.lockPath).isSymbolicLink() &&
        lstatSync(this.lockPath).isFile() &&
        realpathSync(this.lockPath) === resolve(this.lockPath),
      "UNSAFE_PATH",
      "Preference lock must be a regular file without symlinks",
    );
    const lockFd = openSync(
      this.lockPath,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    try {
      requireCondition(
        lstatSync(this.lockPath).isFile() &&
          realpathSync(this.lockPath) === resolve(this.lockPath),
        "UNSAFE_PATH",
        "Preference lock must be a regular file without symlinks",
      );
      fchmodSync(lockFd, 0o600);
    } finally {
      closeSync(lockFd);
    }
  }

  read(): Preferences {
    return withExclusiveLock(
      this.lockPath,
      () => {
        if (!existsSync(this.path)) return fallback;
        try {
          return parsePreferences(readRegular(this.path)) ?? fallback;
        } catch {
          return fallback;
        }
      },
      "preference",
    );
  }

  write(theme: Theme): Preferences {
    requireCondition(
      validTheme(theme),
      "INVALID_PREFERENCES",
      "Theme must be system, light, or dark",
      4,
    );
    return withExclusiveLock(
      this.lockPath,
      () => {
        const next = { schema_version: 1 as const, theme };
        writeAtomic(this.path, JSON.stringify(next, null, 2) + "\n");
        syncDirectory(this.root);
        return next;
      },
      "preference",
    );
  }
}

export function parseThemePayload(value: unknown): Theme {
  requireCondition(
    !!value && typeof value === "object" && !Array.isArray(value),
    "INVALID_PREFERENCES",
    "Preference payload must be an object",
    4,
  );
  const payload = value as Record<string, unknown>;
  requireCondition(
    Object.keys(payload).length === 1 && validTheme(payload.theme),
    "INVALID_PREFERENCES",
    "Preference payload must be exactly {theme}",
    4,
  );
  return payload.theme as Theme;
}
