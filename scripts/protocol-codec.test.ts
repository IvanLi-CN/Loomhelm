import { expect, test } from "bun:test";

import {
  decodeCodexFixtureEnvelope,
  encodeCodexFixtureEnvelope,
} from "../packages/protocol/src/generated";

test("generated TypeScript codec round-trips every Codex fixture envelope", async () => {
  const paths: string[] = [];
  for await (const path of new Bun.Glob("fixtures/codex/samples/*.jsonl").scan({ cwd: "." })) paths.push(path);
  paths.sort();
  expect(paths.length).toBeGreaterThan(0);

  for (const path of paths) {
    const lines = (await Bun.file(path).text()).split(/\r?\n/).filter(Boolean);
    for (const line of lines) {
      const envelope = decodeCodexFixtureEnvelope(line);
      const encoded = encodeCodexFixtureEnvelope(envelope);
      expect(JSON.parse(encoded)).toEqual(JSON.parse(line));
    }
  }
});
