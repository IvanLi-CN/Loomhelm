import { expect, test } from "bun:test";
import { applyViewOutputSnapshot } from "../../web/app-view";
import type { ViewResponse } from "../../web/model";

test("view refresh forwards its starting output epoch to the snapshot fence", () => {
  let requestEpoch: string | null | undefined;
  let outputEpoch = "";
  const result = {
    output_epoch: "current",
    output_revision: 4,
    view: {
      tasks: [{ id: "task-a", thread_id: "thread-a", latest_agent_output: null }],
      groups: [{ id: "group-a", agent_thread_id: "thread-g", latest_agent_output: null }],
    },
  } as unknown as Pick<ViewResponse, "view" | "output_epoch" | "output_revision">;

  applyViewOutputSnapshot(
    (snapshot, epoch) => {
      requestEpoch = epoch;
      outputEpoch = snapshot.output_epoch;
    },
    result,
    "previous",
  );

  expect(requestEpoch).toBe("previous");
  expect(outputEpoch).toBe("current");
});
