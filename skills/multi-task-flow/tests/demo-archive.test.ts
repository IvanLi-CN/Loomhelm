import { expect, test } from "bun:test";
import { archiveFixtureScript } from "../lib/demo-archive";

test("static archive fixture creates a resource and restores it without changing task state", async () => {
  const fixture = { revision: 1, view: { tasks: [{ id: "scheduler", thread_id: "demo-scheduler", state: "closed", conversation_resource: null }] } };
  const target = {} as { fetch: typeof fetch; demoArchiveCalls: string[] };
  new Function("window", "Response", archiveFixtureScript(JSON.stringify(fixture), "{}", "{}"))(target, Response);
  const operate = async (action: string) => (await target.fetch("api/conversation-archive", {
    method: "POST", body: JSON.stringify({ task_id: "scheduler", action }),
  })).json();

  expect(await operate("archive")).toMatchObject({ status: "closed", target: "demo-scheduler", error: null });
  expect(await operate("unarchive")).toMatchObject({ status: "active", archive_policy: "manual" });
  expect(await operate("archive")).toMatchObject({ status: "closed", archive_policy: "auto" });
  const state = await (await target.fetch("api/view")).json();
  expect(state.view.tasks[0].state).toBe("closed");
  expect(state.revision).toBe(4);
  expect(target.demoArchiveCalls).toEqual(["scheduler", "scheduler", "scheduler"]);
});
