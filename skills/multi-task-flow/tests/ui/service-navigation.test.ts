import { expect, test } from "bun:test";
import { Window } from "happy-dom";
import { runClientScript } from "../../lib/service-pages";

test("navigation and compatibility warnings stay inside the dashboard", async () => {
  const dom = new Window({
    url: "http://localhost/runs/orchestration-viewer/",
  });
  dom.document.body.innerHTML =
    '<div class="shell"><header><div class="brand-mark" aria-hidden="true"><span>icon</span></div></header><main><div id="connection-notice" hidden></div></main></div>';
  dom.setInterval = (() => setTimeout(() => {}, 0)) as typeof dom.setInterval;
  dom.fetch = async (url) =>
    new dom.Response(
      JSON.stringify(
        url === "api/service"
          ? { build_id: "candidate", warning: "兼容性提示" }
          : {},
      ),
      { status: 200 },
    );
  dom.eval(runClientScript);
  await new Promise((resolve) => setTimeout(resolve, 10));
  expect(dom.document.body.children.length).toBe(1);
  const home = dom.document.querySelector("header a");
  expect(home?.getAttribute("href")).toBe("/");
  expect(home?.getAttribute("aria-label")).toBe("全部编排运行");
  expect(home?.getAttribute("aria-hidden")).toBeNull();
  expect(dom.document.querySelector("main .notice")?.textContent).toBe(
    "兼容性提示",
  );
  expect(dom.document.body.textContent).not.toContain("service ensure");
  await dom.happyDOM.close();
});

test("lease failures signal the dashboard without adding another banner", async () => {
  const dom = new Window({
    url: "http://localhost/runs/orchestration-viewer/",
  });
  dom.document.body.innerHTML =
    '<div class="shell"><div id="connection-notice">快照提示</div></div>';
  dom.setInterval = (() => setTimeout(() => {}, 0)) as typeof dom.setInterval;
  let expired = false;
  dom.document.addEventListener("service-session", (event) => {
    expired = event instanceof dom.CustomEvent && Boolean(event.detail.expired);
  });
  dom.fetch = async () => new dom.Response("{}", { status: 401 });
  dom.eval(runClientScript);
  await new Promise((resolve) => setTimeout(resolve, 10));
  expect(expired).toBe(true);
  expect(dom.document.body.children.length).toBe(1);
  expect(dom.document.querySelector("#connection-notice")?.textContent).toBe(
    "快照提示",
  );
  await dom.happyDOM.close();
});

test("unauthenticated task target survives the existing login flow", async () => {
  const { resumeTaskScript, loginScript } = await import("../../lib/service-pages");
  const dom = new Window({ url: "http://localhost/runs/run-a/?selected=task%3AC2&detail=1&q=hidden" });
  dom.document.body.innerHTML = '<p id="status"></p>';
  dom.eval(resumeTaskScript);
  expect(dom.sessionStorage.getItem("multi-task-flow.pending-task")).toBe("/runs/run-a/?selected=task%3AC2&detail=1");
  dom.history.replaceState(null, "", "/login#one-time-ticket");
  dom.fetch = async () => new dom.Response(JSON.stringify({ target: "/" }));
  dom.eval(loginScript);
  await new Promise(resolve => setTimeout(resolve, 10));
  expect(dom.location.pathname + dom.location.search).toBe("/runs/run-a/?selected=task%3AC2&detail=1");
  expect(dom.location.hash).toBe("");
  expect(dom.sessionStorage.getItem("multi-task-flow.pending-task")).toBeNull();
  await dom.happyDOM.close();
});
