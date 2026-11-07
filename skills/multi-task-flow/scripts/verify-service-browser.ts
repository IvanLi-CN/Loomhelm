// CI synthetic interactions plus a pure-frontend ui_demo evidence surface.
import { chromium } from "playwright";
import { mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { createDemoLedger } from "../examples/orchestration-viewer/ledger";
import { buildView } from "./view";
import {
  homePage,
  homeScript,
  loginPage,
  loginScript,
  runClientScript,
} from "./service-pages";
import { startSharedViewer } from "./service-http";
import { ServiceAuth } from "./service-auth";
import {
  serviceFixture,
  fixtureRelease,
  fixtureRun,
} from "../tests/service-fixture";

const output = resolve(process.argv[2]!);
mkdirSync(output, { recursive: true });
const dist = resolve(import.meta.dir, "../dist");
const browser = await chromium.launch({ headless: true });
const fixture = serviceFixture();
const bundle = fixtureRelease(fixture.root);
fixtureRun(fixture.state.paths.data);
const viewer = await startSharedViewer(fixture.state, bundle.manifest, dist, 0);
const base = `http://127.0.0.1:${viewer.port}`;
const scenarios: string[] = [];
try {
  const live = await browser.newContext();
  const page = await live.newPage();
  await page.goto(base + "/login#" + new ServiceAuth(fixture.state).ticket());
  await page.waitForURL(base + "/");
  await page.getByRole("link", { name: "demo-run", exact: true }).click();
  await page.waitForURL(base + "/runs/demo-run/");
  await page.waitForFunction(() =>
    document.querySelector("#connection")?.textContent?.includes("实时"),
  );
  const response = await page.request.get(base + "/api/v1/runs");
  if (!response.ok())
    throw new Error("Browser login did not retain its session");
  scenarios.push(
    "single-use login, run navigation and authenticated browser session",
  );
  await live.close();

  const ledger = createDemoLedger(Date.parse("2026-11-04T09:00:00.000Z"));
  const sourceHtml =
    readFileSync(join(dist, "index.html"), "utf8") +
    '<script src="/service-client.js" defer></script>';
  const images: string[] = [];
  for (const viewport of [
    { width: 1440, height: 1000 },
    { width: 393, height: 852 },
  ]) {
    const context = await browser.newContext({
      viewport,
      colorScheme: "light",
    });
    await context.addInitScript(() => {
      class MockEvents {
        addEventListener(name: string, callback: EventListener) {
          if (name === "open")
            queueMicrotask(() => callback(new Event("open")));
        }
        close() {}
      }
      Object.defineProperty(window, "EventSource", { value: MockEvents });
    });
    await context.route("http://mtf.test/**", async (route) => {
      const url = new URL(route.request().url());
      if (url.pathname === "/api/v1/login") {
        await route.fulfill({ status: 401, body: "{}" });
        return;
      }
      let body: string;
      let contentType = "application/json";
      if (url.pathname === "/") {
        body = homePage;
        contentType = "text/html";
      } else if (url.pathname === "/login") {
        body = loginPage;
        contentType = "text/html";
      } else if (url.pathname === "/home.js") {
        body = homeScript;
        contentType = "text/javascript";
      } else if (url.pathname === "/login.js") {
        body = loginScript;
        contentType = "text/javascript";
      } else if (url.pathname === "/service-client.js") {
        body = runClientScript;
        contentType = "text/javascript";
      } else if (url.pathname === "/runs/demo-run/") {
        body = sourceHtml;
        contentType = "text/html";
      } else if (
        url.pathname.endsWith("app.js") ||
        url.pathname.endsWith("app.css")
      ) {
        const name = url.pathname.endsWith("app.js") ? "app.js" : "app.css";
        body = readFileSync(join(dist, name), "utf8");
        contentType = name.endsWith("js") ? "text/javascript" : "text/css";
      } else if (url.pathname === "/api/v1/runs")
        body = JSON.stringify({
          total: 2,
          build_id: "synthetic-build",
          runs: [
            {
              id: "demo-run",
              revision: ledger.revision,
              owner_thread_id: "synthetic-main",
            },
            { id: "archive-run", error: "INCOMPATIBLE_LEDGER" },
          ],
        });
      else if (url.pathname.endsWith("/api/view"))
        body = JSON.stringify({
          revision: ledger.revision,
          watching: true,
          active_plan_id: ledger.active_plan_id,
          view: buildView(ledger, url.searchParams.get("plan") ?? undefined),
        });
      else if (url.pathname.endsWith("/api/preferences"))
        body = JSON.stringify({ schema_version: 1, theme: "light" });
      else if (url.pathname.endsWith("/api/service"))
        body = JSON.stringify({
          build_id: "synthetic-build",
          warning: "自定义视图不兼容，已使用共享模板。",
        });
      else body = "{}";
      await route.fulfill({ body, contentType });
    });
    const demo = await context.newPage();
    await demo.clock.setFixedTime("2026-11-04T09:00:00.000Z");
    await demo.goto("http://mtf.test/");
    await demo.getByRole("link", { name: "demo-run", exact: true }).waitFor();
    const homeImage = `runs-${viewport.width}.png`;
    await demo.screenshot({ path: join(output, homeImage), fullPage: true });
    images.push(homeImage);
    await demo.getByRole("link", { name: "demo-run", exact: true }).click();
    await demo
      .getByText("自定义视图不兼容，已使用共享模板。", { exact: true })
      .waitFor();
    await demo.waitForFunction(
      () =>
        document.querySelectorAll(".task-card").length > 0 ||
        document.querySelectorAll("[data-task-id]").length > 0,
    );
    const runImage = `run-${viewport.width}.png`;
    await demo.screenshot({ path: join(output, runImage), fullPage: true });
    images.push(runImage);
    await demo.goto("http://mtf.test/login");
    await demo
      .getByText("入口已过期或已使用。请通过 service login 重新获取。", {
        exact: true,
      })
      .waitFor();
    const loginImage = `login-${viewport.width}.png`;
    await demo.screenshot({ path: join(output, loginImage), fullPage: true });
    images.push(loginImage);
    await context.close();
  }
  scenarios.push(
    "pure frontend desktop and 393x852 mobile runs, compatibility fallback and login expiry",
  );
  writeFileSync(
    join(output, "evidence.json"),
    JSON.stringify(
      {
        candidate_sha: Bun.spawnSync(["git", "rev-parse", "HEAD"])
          .stdout.toString()
          .trim(),
        source: "ui_demo",
        backend: "mock-only for captures",
        images,
        scenarios,
      },
      null,
      2,
    ),
  );
} finally {
  await viewer.stop();
  await browser.close();
  rmSync(fixture.root, { recursive: true, force: true });
}
