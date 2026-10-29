import { expect, userEvent, waitFor, within } from "storybook/test";
import { useEffect, useRef, useState } from "react";

import type { Meta, StoryObj } from "@storybook/react-vite";

import { useRouteContentFocus } from "./route-focus";
import { queueOwnedFocusRestore } from "@/lib/focus-ownership";

const meta = {
  title: "Product/RouteContentFocus",
  parameters: { layout: "fullscreen" },
  tags: ["autodocs"]
} satisfies Meta;

export default meta;

type Story = StoryObj<typeof meta>;

function RouteContentFocusHarness() {
  const [location, setLocation] = useState({ pathname: "/tasks", search: "" });
  const contentRef = useRouteContentFocus(location.pathname);
  const headingRef = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    if (!location.pathname.startsWith("/tasks/")) return;
    const frame = requestAnimationFrame(() => headingRef.current?.focus({ preventScroll: true }));
    return () => cancelAnimationFrame(frame);
  }, [location.pathname]);

  return (
    <div className="min-h-screen bg-[var(--canvas)] p-8">
      <nav aria-label="测试导航" className="flex gap-2">
        <button type="button" className="button button-secondary" onClick={() => setLocation({ pathname: "/projects/project-1", search: "" })}>打开项目</button>
        <button type="button" className="button button-secondary" onClick={() => setLocation({ pathname: "/tasks/task-1", search: "" })}>打开任务</button>
      </nav>
      <label className="mt-4 block">搜索任务<input type="search" value={location.search} onChange={(event) => setLocation((current) => ({ ...current, search: event.target.value }))} /></label>
      <main ref={contentRef} className="product-content mt-4 min-h-32" tabIndex={-1} aria-label="主要内容">
        {location.pathname.startsWith("/projects") ? <h1>项目页面</h1> : location.pathname.startsWith("/tasks/") ? <h1 ref={headingRef} tabIndex={-1}>任务工作区</h1> : <h1>任务列表</h1>}
      </main>
    </div>
  );
}

export const RouteNavigationFocusesMainContent: Story = {
  render: () => <RouteContentFocusHarness />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const main = canvas.getByRole("main", { name: "主要内容" });

    await userEvent.click(canvas.getByRole("button", { name: "打开任务" }));
    const taskHeading = canvas.getByRole("heading", { name: "任务工作区" });
    await waitFor(() => expect(taskHeading).toHaveFocus());

    await userEvent.click(canvas.getByRole("button", { name: "打开项目" }));
    await waitFor(() => expect(main).toHaveFocus());
    expect(main).toHaveTextContent("项目页面");

    await userEvent.click(canvas.getByRole("button", { name: "打开任务" }));
    await waitFor(() => expect(canvas.getByRole("heading", { name: "任务工作区" })).toHaveFocus());

    const search = canvas.getByRole("searchbox", { name: "搜索任务" });
    await userEvent.type(search, "TASK-1");
    expect(search).toHaveFocus();
    expect(main).not.toHaveFocus();
  }
};

function DeferredTaskArrivalHarness() {
  const [loaded, setLoaded] = useState(false);
  const [loading, setLoading] = useState(false);
  const contentRef = useRef<HTMLElement>(null);
  const routeRef = useRef<HTMLElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    if (!loading) return;
    const timer = window.setTimeout(() => setLoaded(true), 0);
    return () => window.clearTimeout(timer);
  }, [loading]);

  useEffect(() => {
    if (!loaded) return;
    const owner = routeRef.current?.closest("main") ?? routeRef.current;
    queueOwnedFocusRestore(owner, () => headingRef.current);
  }, [loaded]);

  return (
    <div className="min-h-screen bg-[var(--canvas)] p-8">
      <header><button type="button" className="button button-secondary" onClick={() => undefined}>主题</button></header>
      <main ref={contentRef} tabIndex={-1} aria-label="主要内容">
        <section ref={routeRef} className="mt-4 min-h-32">
          {loaded ? <h1 ref={headingRef} tabIndex={-1}>任务工作区</h1> : <p>正在读取任务</p>}
          <button type="button" className="button button-secondary" onClick={() => setLoading(true)}>开始读取</button>
        </section>
      </main>
    </div>
  );
}

export const DeferredTaskArrivalPreservesExternalFocus: Story = {
  render: () => <DeferredTaskArrivalHarness />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const headerButton = canvas.getByRole("button", { name: "主题" });
    await userEvent.click(canvas.getByRole("button", { name: "开始读取" }));
    await userEvent.click(headerButton);
    await waitFor(() => expect(canvas.getByRole("heading", { name: "任务工作区" })).toBeInTheDocument());
    await waitFor(() => expect(headerButton).toHaveFocus());
    expect(canvas.getByRole("heading", { name: "任务工作区" })).not.toHaveFocus();
  }
};
