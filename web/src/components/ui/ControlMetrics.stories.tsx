import { useEffect } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { Check, Plus, Search } from "lucide-react";

import { Button } from "./button";
import { Input } from "./input";
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "./select";

const meta = {
  title: "UI/ControlMetrics",
  parameters: { layout: "fullscreen" }
} satisfies Meta;

export default meta;
type Story = StoryObj<typeof meta>;

function ThemeFrame({ theme }: { theme: "light" | "dark" }) {
  useEffect(() => {
    const root = document.documentElement;
    const previousTheme = root.dataset.theme;
    root.dataset.theme = theme;
    return () => {
      if (previousTheme) root.dataset.theme = previousTheme;
      else delete root.dataset.theme;
    };
  }, [theme]);

  return (
    <div className="min-h-screen bg-[var(--canvas)] p-10" data-visual-evidence-surface>
      <div className="control-metrics-gallery" data-visual-evidence-target>
        <div>
          <span className="section-kicker">SHARED CONTROL METRICS</span>
          <h1 className="mt-2 text-xl font-semibold">控件尺寸与状态</h1>
        </div>
        <div className="control-metrics-row" aria-label="工具栏控件">
          <Button type="button" variant="secondary" className="button button-secondary">
            <Check size={16} aria-hidden="true" />确认
          </Button>
          <Button type="button" variant="default" size="icon" className="button button-primary" aria-label="添加">
            <Plus size={16} aria-hidden="true" />
          </Button>
          <Select defaultValue="system">
            <SelectTrigger size="sm" aria-label="界面主题">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                <SelectItem value="system">系统主题</SelectItem>
                <SelectItem value="light">亮色</SelectItem>
                <SelectItem value="dark">暗色</SelectItem>
              </SelectGroup>
            </SelectContent>
          </Select>
        </div>
        <div className="control-metrics-row" aria-label="工具栏搜索">
          <span className="control-metrics-context">工具栏搜索</span>
          <div className="search-field control-metrics-search">
            <Search size={16} aria-hidden="true" />
            <Input aria-label="工具栏搜索内容" defaultValue="整理工作区" />
          </div>
        </div>
        <div className="control-metrics-row" aria-label="大尺寸控件">
          <Button type="button" variant="secondary" size="lg" data-control-size="lg">
            大号按钮
          </Button>
          <Button type="button" variant="secondary" size="icon-lg" data-control-size="icon-lg" aria-label="大号图标按钮">
            <Plus size={18} aria-hidden="true" />
          </Button>
        </div>
        <div className="control-metrics-row control-metrics-row-form" aria-label="表单控件">
          <label className="control-metrics-field">
            <span>搜索</span>
            <Input aria-label="搜索内容" defaultValue="整理工作区" />
          </label>
          <label className="control-metrics-field">
            <span>状态</span>
            <Select defaultValue="active">
              <SelectTrigger aria-label="任务状态">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  <SelectItem value="active">进行中</SelectItem>
                  <SelectItem value="done">已完成</SelectItem>
                </SelectGroup>
              </SelectContent>
            </Select>
          </label>
        </div>
        <div className="control-metrics-row" aria-label="控件状态">
          <Button type="button" variant="secondary" className="button button-secondary" autoFocus>
            键盘焦点
          </Button>
          <Button type="button" variant="secondary" size="icon" className="button button-secondary" disabled aria-label="禁用添加">
            <Plus size={16} aria-hidden="true" />
          </Button>
          <Input aria-label="禁用输入" defaultValue="禁用" disabled />
          <Select defaultValue="active" disabled>
            <SelectTrigger aria-label="禁用状态">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                <SelectItem value="active">进行中</SelectItem>
              </SelectGroup>
            </SelectContent>
          </Select>
        </div>
      </div>
    </div>
  );
}

export const Light: Story = { render: () => <ThemeFrame theme="light" /> };
export const Dark: Story = { render: () => <ThemeFrame theme="dark" /> };
