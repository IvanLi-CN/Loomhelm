import { expect, test } from "bun:test";
import { isCanonicalTaskKind, validateNewTaskKinds } from "../lib/schema";

test("only canonical task kinds are eligible for new runtime tasks", () => {
  expect(["contribution", "release", "deployment", "verification"].every((kind) => isCanonicalTaskKind(kind as any))).toBe(true);
  expect(isCanonicalTaskKind("coordination" as any)).toBe(false);
  expect(isCanonicalTaskKind("development" as any)).toBe(false);
  expect(isCanonicalTaskKind("other" as any)).toBe(false);
});

test("retired coordination task kinds are rejected for new tasks", () => {
  expect(() => validateNewTaskKinds([{ id: "coord", kind: "coordination" } as any])).toThrow("retired task kind");
  expect(() => validateNewTaskKinds([{ id: "verify", kind: "verification" } as any])).not.toThrow();
});
