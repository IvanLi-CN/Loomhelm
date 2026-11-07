import { expect, test } from "bun:test";
import {
  copyFileSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createReport } from "../../modules/visual/report_create";
import { createSnapshot } from "../../modules/visual/snapshot";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "visual-report-integrity-"));
  const store = join(root, "user-inline-assets");
  const source = join(root, "source.png");
  writeFileSync(source, "snapshot");
  const now = new Date("2026-10-27T01:02:03.000Z");
  const expected = createSnapshot({
    source,
    cwd: root,
    storeRoot: store,
    now,
    rand8: "00000001",
  });
  const actual = createSnapshot({
    source,
    cwd: root,
    storeRoot: store,
    now,
    rand8: "00000002",
  });
  return { root, store, expected, actual, now };
}

function validRunner(directory: string): undefined {
  const filename = readdirSync(join(directory, "actual"))[0]!;
  writeFileSync(
    join(directory, "report.html"),
    `<html><div id="app"></div><script>window['__reg__'] = ${JSON.stringify({ actualDir: "./actual", expectedDir: "./expected", diffDir: "./diff", newItems: [], deletedItems: [], hasNew: false, hasDeleted: false, hasFailed: true, hasPassed: false, failedItems: [{ raw: filename, encoded: filename }], passedItems: [] })};</script><script>function renderReport(){ return 'rendered'; }</script></html>`,
  );
  writeFileSync(
    join(directory, "reg.json"),
    JSON.stringify({
      actualItems: [filename],
      expectedItems: [filename],
      failedItems: [filename],
      passedItems: [],
      diffItems: [`${filename.slice(0, -4)}.png`],
    }),
  );
  writeFileSync(
    join(directory, "diff", `${filename.slice(0, -4)}.png`),
    "diff",
  );
  return undefined;
}

function createOptions(
  data: ReturnType<typeof fixture>,
  token: string,
  overrides: {
    runRegCli?: (directory: string) => undefined;
    beforePublish?: () => void;
  } = {},
) {
  return {
    pairs: [
      {
        name: "page",
        expected: data.expected.snapshot_path,
        actual: data.actual.snapshot_path,
      },
    ],
    cwd: data.root,
    storeRoot: data.store,
    now: data.now,
    token,
    runRegCli: validRunner,
    cloneFile: (source: string, destination: string) =>
      copyFileSync(source, destination),
    ...overrides,
  };
}

function reportParent(data: ReturnType<typeof fixture>): string {
  return join(
    data.store,
    data.expected.repo_scope,
    "2026",
    "10",
    "27",
    "reg-cli-reports",
  );
}

test("report creation rechecks snapshot integrity and rolls back publication", () => {
  const first = fixture();
  try {
    expect(() =>
      createReport(
        createOptions(first, "00000001", {
          runRegCli: (directory) => {
            validRunner(directory);
            writeFileSync(first.actual.snapshot_path, "changed");
          },
        }),
      ),
    ).toThrow("snapshot input changed during report generation");
    expect(readdirSync(reportParent(first))).toEqual([]);
  } finally {
    rmSync(first.root, { recursive: true, force: true });
  }

  const second = fixture();
  try {
    expect(() =>
      createReport(
        createOptions(second, "00000002", {
          beforePublish: () =>
            writeFileSync(second.actual.snapshot_path, "changed"),
        }),
      ),
    ).toThrow("snapshot input changed during report generation");
    expect(readdirSync(reportParent(second))).toEqual([]);
    expect(existsSync(second.actual.snapshot_path)).toBe(true);
    expect(readFileSync(second.actual.snapshot_path, "utf8")).toBe("changed");
  } finally {
    rmSync(second.root, { recursive: true, force: true });
  }
});
