// Browser interactions and visual evidence against the local service fixture.

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { chromium } from "playwright";
import { ServiceAuth } from "../lib/service-auth";
import { startSharedViewer } from "../lib/service-http";
import {
  bindHistoricalFixture,
  fixtureRelease,
  fixtureRun,
  serviceFixture,
} from "../tests/service-fixture";

const output = resolve(process.argv[2]!);
mkdirSync(output, { recursive: true });
const dist = resolve(import.meta.dir, "../dist");
const browser = await chromium.launch({ headless: true });
const fixture = serviceFixture();
const bundle = fixtureRelease(fixture.root);
fixtureRun(fixture.state.paths.data);
bindHistoricalFixture(fixture.state, "demo-run", bundle.manifest);
const initialViewer = await startSharedViewer(fixture.state, bundle.manifest, dist, 0);
let activeViewer: Awaited<ReturnType<typeof startSharedViewer>> | null = initialViewer;
const base = `http://127.0.0.1:${initialViewer.port}`;
const scenarios: string[] = [];
try {
  const live = await browser.newContext();
  const page = await live.newPage();
  const loginUrl = new URL(base + "/runs/demo-run/");
  loginUrl.searchParams.set("ticket", new ServiceAuth(fixture.state).ticket("/runs/demo-run/"));
  await page.goto(loginUrl.toString());
  await page.waitForURL(base + "/runs/demo-run/");
  await page.waitForFunction(() =>
    document.querySelector("#connection")?.textContent?.includes("实时"),
  );
  const embeddedProvenance = JSON.parse(
    (await page.locator("script#loomhelm-viewer-provenance").textContent()) ?? "null",
  );
  const liveRuntime = await page.evaluate(async () => {
    const response = await fetch("api/service", { cache: "no-store" });
    return { ok: response.ok, value: await response.json() };
  });
  const comparableEmbeddedProvenance =
    embeddedProvenance &&
    embeddedProvenance.build_id === "__LOOMHELM_ARTIFACT_BUILD_ID__" &&
    liveRuntime.value.runtime?.static_viewer?.build_id
      ? { ...embeddedProvenance, build_id: liveRuntime.value.runtime.static_viewer.build_id }
      : embeddedProvenance;
  if (
    !liveRuntime.ok ||
    JSON.stringify(liveRuntime.value.runtime?.static_viewer) !==
      JSON.stringify(comparableEmbeddedProvenance)
  )
    throw new Error("Live service runtime metadata does not match the page provenance marker");
  const response = await page.request.get(base + "/api/v1/runs");
  if (!response.ok()) throw new Error("Browser login did not retain its session");
  scenarios.push(
    "single-use target ticket, URL cleanup, authenticated browser session and live runtime identity consistency",
  );
  await live.close();
  await activeViewer!.stop();
  activeViewer = null;

  const images: string[] = [];
  const observations: Record<string, unknown>[] = [];
  for (const viewport of [
    { width: 1600, height: 1000 },
    { width: 1440, height: 900 },
    { width: 1024, height: 768 },
    { width: 393, height: 852 },
  ]) {
    console.log(`[evidence] viewport ${viewport.width}x${viewport.height}: opening live run`);
    const viewportViewer = await startSharedViewer(fixture.state, bundle.manifest, dist, 0);
    activeViewer = viewportViewer;
    const viewportBase = `http://127.0.0.1:${viewportViewer.port}`;
    const context = await browser.newContext({
      viewport,
      colorScheme: "light",
    });
    const demo = await context.newPage();
    const loginUrl = new URL(viewportBase + "/runs/demo-run/");
    loginUrl.searchParams.set("ticket", new ServiceAuth(fixture.state).ticket("/runs/demo-run/"));
    await demo.goto(loginUrl.toString());
    await demo.waitForURL(viewportBase + "/runs/demo-run/");
    const actualViewport = await demo.evaluate(() => ({
      width: window.innerWidth,
      height: window.innerHeight,
    }));
    if (actualViewport.width !== viewport.width || actualViewport.height !== viewport.height)
      throw new Error(
        `Browser viewport changed from the requested size: ${JSON.stringify({ requested: viewport, actual: actualViewport })}`,
      );
    console.log(
      `[evidence] viewport ${viewport.width}x${viewport.height}: authenticated page ready`,
    );
    try {
      await demo.waitForFunction(
        () =>
          document.querySelectorAll(".task-card").length > 0 ||
          document.querySelectorAll("[data-task-id]").length > 0,
      );
    } catch (error) {
      const state = await demo.evaluate(() => ({
        url: location.href,
        title: document.title,
        body: document.body.textContent?.trim().slice(0, 240),
        connection: document.querySelector("#connection")?.textContent,
        loadError: document.querySelector("#load-error")?.textContent,
        cards: document.querySelectorAll(".task-card").length,
        taskIds: document.querySelectorAll("[data-task-id]").length,
      }));
      throw new Error(
        `Live service view did not hydrate at ${viewport.width}x${viewport.height}: ${JSON.stringify(state)}; ${error}`,
      );
    }
    console.log(`[evidence] viewport ${viewport.width}x${viewport.height}: view hydrated`);
    const runImage = `run-${viewport.width}.png`;
    await demo.screenshot({ path: join(output, runImage) });
    images.push(runImage);
    await demo.locator("#plan-info-trigger").click();
    await demo.locator(".plan-info-identity-package").waitFor();
    if (viewport.width >= 768) {
      const panelGeometry = await demo.locator(".plan-info-panel").evaluate((node) => {
        const rect = node.getBoundingClientRect();
        return {
          left: rect.left,
          right: rect.right,
          top: rect.top,
          bottom: rect.bottom,
          viewportWidth: window.innerWidth,
          viewportHeight: window.innerHeight,
        };
      });
      if (
        panelGeometry.left < 8 ||
        panelGeometry.right > panelGeometry.viewportWidth - 8 ||
        panelGeometry.top < 8 ||
        panelGeometry.bottom > panelGeometry.viewportHeight - 8
      )
        throw new Error(
          `Plan information panel is not contained in the medium desktop viewport: ${JSON.stringify(panelGeometry)}`,
        );
    }
    const runtimeDisclosure = demo.locator("details.plan-info-disclosure-mobile");
    if ((await runtimeDisclosure.getAttribute("open")) !== null)
      throw new Error("Runtime identity details should be collapsed by default");
    if (viewport.width >= 1024) {
      const trigger = demo.locator(".plan-info-identity-trigger");
      await trigger.waitFor();
      if ((await trigger.getAttribute("aria-expanded")) !== "false")
        throw new Error("Desktop version details should be closed by default");
      await trigger.click();
      const tooltip = demo.locator(".plan-info-identity-tooltip");
      await tooltip.waitFor();
      if (
        (await tooltip.getAttribute("hidden")) !== null ||
        !(await tooltip.evaluate((node) => node.classList.contains("is-open")))
      )
        throw new Error("Desktop version details tooltip did not open");
      const geometry = await demo.evaluate(() => {
        const trigger = document.querySelector<HTMLElement>(".plan-info-identity-trigger")!;
        const tooltip = document.querySelector<HTMLElement>(".plan-info-identity-tooltip")!;
        const panel = document.querySelector<HTMLElement>(".plan-info-panel")!;
        const triggerRect = trigger.getBoundingClientRect();
        const tooltipRect = tooltip.getBoundingClientRect();
        const panelRect = panel.getBoundingClientRect();
        return {
          fieldCount: tooltip.querySelectorAll(".plan-info-field").length,
          placement: tooltip.dataset.placement,
          triggerRight: triggerRect.right,
          panelRight: panelRect.right,
          tooltipLeft: tooltipRect.left,
          tooltipRight: tooltipRect.right,
          tooltipTop: tooltipRect.top,
          tooltipBottom: tooltipRect.bottom,
          tooltipScrollHeight: tooltip.scrollHeight,
          tooltipClientHeight: tooltip.clientHeight,
          viewportRight: window.innerWidth,
          viewportBottom: window.innerHeight,
        };
      });
      if (geometry.placement !== "right")
        throw new Error(
          `Desktop version tooltip did not use its required right-side placement: ${JSON.stringify(geometry)}`,
        );
      if (
        geometry.tooltipLeft < Math.max(geometry.triggerRight, geometry.panelRight) + 11 ||
        geometry.tooltipRight > geometry.viewportRight - 11 ||
        geometry.tooltipTop < 8 ||
        geometry.tooltipBottom > geometry.viewportBottom - 8
      )
        throw new Error(
          `Desktop version tooltip is not fully separated from its owner and viewport edges: ${JSON.stringify(geometry)}`,
        );
      if (geometry.fieldCount !== 13)
        throw new Error(
          `Desktop version tooltip is missing runtime identity fields: ${JSON.stringify(geometry)}`,
        );
      if (geometry.tooltipScrollHeight > geometry.tooltipClientHeight + 2)
        throw new Error(
          `Desktop version tooltip is still clipped at the desktop evidence viewport: ${JSON.stringify(geometry)}`,
        );
      observations.push({
        viewport: `${viewport.width}x${viewport.height}`,
        version_details: geometry,
      });
      const versionImage = `version-${viewport.width}.png`;
      await demo.screenshot({ path: join(output, versionImage) });
      images.push(versionImage);
      await demo.keyboard.press("Escape");
      await tooltip.waitFor({ state: "hidden" });
      await trigger.click();
      await tooltip.waitFor({ state: "visible" });
      await demo.keyboard.press("Escape");
      await tooltip.waitFor({ state: "hidden" });
    } else {
      await runtimeDisclosure.locator("summary").click();
      const mobileGeometry = await demo.evaluate(() => {
        const panel = document.querySelector<HTMLElement>(".plan-info-panel")!;
        const body = document.querySelector<HTMLElement>(".plan-info-content")!;
        const rect = panel.getBoundingClientRect();
        return {
          viewportWidth: window.innerWidth,
          viewportHeight: window.innerHeight,
          panelLeft: rect.left,
          panelRight: rect.right,
          panelTop: rect.top,
          panelBottom: rect.bottom,
          fieldCount: document.querySelectorAll(".plan-info-disclosure-mobile .plan-info-field")
            .length,
          disclosureOpen:
            document.querySelector(".plan-info-disclosure-mobile")?.hasAttribute("open") ?? false,
          contentScrollHeight: body.scrollHeight,
          contentClientHeight: body.clientHeight,
        };
      });
      if (!mobileGeometry.disclosureOpen || mobileGeometry.fieldCount !== 13)
        throw new Error(
          `Mobile version details did not reveal the complete identity: ${JSON.stringify(mobileGeometry)}`,
        );
      if (
        mobileGeometry.panelLeft < 0 ||
        mobileGeometry.panelRight > mobileGeometry.viewportWidth ||
        mobileGeometry.panelTop < 0 ||
        mobileGeometry.panelBottom > mobileGeometry.viewportHeight
      )
        throw new Error(
          `Mobile plan information drawer is not contained in its viewport: ${JSON.stringify(mobileGeometry)}`,
        );
      observations.push({
        viewport: `${viewport.width}x${viewport.height}`,
        mobile_version_details: mobileGeometry,
      });
      const mobileVersionImage = `version-mobile-${viewport.width}.png`;
      await demo.screenshot({ path: join(output, mobileVersionImage) });
      images.push(mobileVersionImage);
      const mobileScroll = await demo.locator(".plan-info-content").evaluate((node) => {
        const element = node as HTMLElement;
        const fields = element.querySelector<HTMLElement>(
          ".plan-info-disclosure-mobile .plan-info-identity-fields",
        )!;
        const elementRect = element.getBoundingClientRect();
        const fieldsRect = fields.getBoundingClientRect();
        const target = element.scrollTop + fieldsRect.bottom - elementRect.bottom + 12;
        element.scrollTop = Math.min(
          element.scrollHeight - element.clientHeight,
          Math.max(0, target),
        );
        return {
          scrollTop: element.scrollTop,
          scrollHeight: element.scrollHeight,
          clientHeight: element.clientHeight,
        };
      });
      const mobileBottom = await demo.evaluate(() => ({
        lastField:
          [
            ...document.querySelectorAll<HTMLElement>(
              ".plan-info-disclosure-mobile .plan-info-field",
            ),
          ]
            .at(-1)
            ?.textContent?.trim() ?? "",
        lastFieldGeometry: (() => {
          const body = document.querySelector<HTMLElement>(".plan-info-content")!;
          const field = document.querySelector<HTMLElement>(
            ".plan-info-disclosure-mobile .plan-info-identity-fields .plan-info-field:last-child",
          )!;
          const bodyRect = body.getBoundingClientRect();
          const fieldRect = field.getBoundingClientRect();
          return {
            top: fieldRect.top,
            bottom: fieldRect.bottom,
            visibleTop: bodyRect.top,
            visibleBottom: bodyRect.bottom,
          };
        })(),
        viewportWidth: window.innerWidth,
        viewportHeight: window.innerHeight,
      }));
      if (!mobileBottom.lastField.startsWith("Daemon source SHA"))
        throw new Error(
          `Mobile version details did not expose the final identity field: ${JSON.stringify(mobileBottom)}`,
        );
      if (
        mobileBottom.lastFieldGeometry.top < mobileBottom.lastFieldGeometry.visibleTop ||
        mobileBottom.lastFieldGeometry.bottom > mobileBottom.lastFieldGeometry.visibleBottom
      )
        throw new Error(
          `Mobile version details final field is not visible inside the fixed viewport: ${JSON.stringify(mobileBottom)}`,
        );
      observations.push({
        viewport: `${viewport.width}x${viewport.height}`,
        mobile_version_details_bottom: { ...mobileScroll, ...mobileBottom },
      });
      const mobileIdentityBottomImage = `version-mobile-${viewport.width}-identity-bottom.png`;
      await demo.screenshot({ path: join(output, mobileIdentityBottomImage) });
      images.push(mobileIdentityBottomImage);
    }
    await demo.locator("#close-plan-info").click();
    await demo.getByRole("tab", { name: "任务与交付单元依赖", exact: true }).click();
    await demo.locator('#graph [data-context-task="model"]').click();
    const relations = demo.locator(".detail-relations");
    await relations.waitFor();
    if ((await relations.getAttribute("open")) !== null)
      throw new Error("Relationships should be collapsed by default");
    if (await demo.locator(".detail-relations-trigger, .detail-relations-tooltip").count())
      throw new Error("Relationship details must not use the version tooltip surface");
    await context.clearCookies();
    await demo.goto(viewportBase + "/auth/failed?redirect=%2Fruns%2Fdemo-run%2F");
    await demo
      .getByText("一次性登录入口已过期或已使用。", {
        exact: true,
      })
      .waitFor();
    const authFailedImage = `auth-failed-${viewport.width}.png`;
    await demo.screenshot({ path: join(output, authFailedImage) });
    images.push(authFailedImage);
    await context.close();
    await viewportViewer.stop();
    activeViewer = null;
  }
  scenarios.push(
    "live service 1600x1000, 1440x900, 1024x768 and 393x852 runs, live runtime identity consistency, compact runtime identity, right-side desktop version-details tooltip, close/reopen lifecycle, collapsed relationship disclosure DOM check and authentication failure",
  );
  writeFileSync(
    join(output, "evidence.json"),
    JSON.stringify(
      {
        candidate_sha: Bun.spawnSync(["git", "rev-parse", "HEAD"]).stdout.toString().trim(),
        source: "live-service-browser",
        backend: "live service fixture",
        viewports: [
          {
            width: 1600,
            height: 1000,
            requested_viewport: "1600x1000",
            viewport_strategy: "live-service",
            capture_scope: "browser-viewport",
          },
          {
            width: 1440,
            height: 900,
            requested_viewport: "1440x900",
            viewport_strategy: "live-service",
            capture_scope: "browser-viewport",
          },
          {
            width: 1024,
            height: 768,
            requested_viewport: "1024x768",
            viewport_strategy: "live-service",
            capture_scope: "browser-viewport",
          },
          {
            width: 393,
            height: 852,
            requested_viewport: "393x852",
            viewport_strategy: "live-service",
            capture_scope: "browser-viewport",
          },
        ],
        images,
        observations,
        scenarios,
      },
      null,
      2,
    ),
  );
} finally {
  await activeViewer?.stop();
  await browser.close();
  rmSync(fixture.root, { recursive: true, force: true });
}
