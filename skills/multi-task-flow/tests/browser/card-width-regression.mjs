/**
 * Real-browser acceptance test. Run against the built, mock-only preview.html.
 * Pass a browser tab (Playwright locator/evaluate API plus getAXState) and the
 * browser's viewport capability. No simulated DOM or CSS formula assertions.
 * For the Codex browser REPL, paste this exported function without `export`,
 * then await checkCardWidths(tab, viewport). Always reset viewport in finally.
 */
export async function checkCardWidths(tab, viewport, widths = [1304, 768, 1024, 1120, 1444], layouts = ["board", "grid"]) {
  const results = [];
  const measure = () => tab.playwright.evaluate(() => ({
    cards: [...document.querySelectorAll("#task-list [data-task-id]")].map(el => ({
      id: el.getAttribute("data-task-id"), width: el.getBoundingClientRect().width,
    })),
    columns: [...document.querySelectorAll("#task-list [data-group-id]")].map(el => ({
      id: el.getAttribute("data-group-id"), width: el.getBoundingClientRect().width,
    })),
    workspaceWidth: document.querySelector(".workspace").getBoundingClientRect().width,
    taskAreaWidth: document.querySelector(".workspace-tasks").getBoundingClientRect().width,
    detailWidth: document.querySelector("#details").getBoundingClientRect().width,
    detailVisible: !document.querySelector("#details").hidden,
    pageOverflow: document.documentElement.scrollWidth > innerWidth,
  }));
  const compare = (before, after) => before.length === after.length && before.every(a => {
    const b = after.find(item => item.id === a.id);
    return b && a.width > 0 && Math.abs(a.width - b.width) < 1;
  });
  try {
    for (const width of widths) {
      await viewport.set({ width, height: 1470 });
      for (const layout of layouts) {
        if (await tab.playwright.locator("#close-details").isVisible()) {
          await tab.playwright.locator("#close-details").click();
          await tab.getAXState({ emit: false });
        }
        await tab.playwright.locator(`#task-layout-${layout}`).click();
        await tab.getAXState({ emit: false });
        const closed = await measure();
        await tab.playwright.getByRole("button", { name: "选择任务：只读视图服务与实时更新，状态：待开始", exact: true }).click();
        await tab.getAXState({ emit: false });
        const opened = await measure();
        await tab.playwright.locator("#close-details").click();
        await tab.getAXState({ emit: false });
        const reclosed = await measure();
        const outerCardWidth = layout === "board" ? opened.columns[0]?.width : opened.cards[0]?.width;
        // Fixed product limits; adding one more complete task track must leave
        // less than the 243px minimum inspector width (including both gaps).
        const inspectorFits = opened.detailWidth >= 242.99 && opened.detailWidth <= 740.01
          && opened.workspaceWidth - (opened.taskAreaWidth + outerCardWidth + 20) - 20 < 243;
        const passed = inspectorFits && closed.cards.length > 0 && (layout !== "board" || closed.columns.length > 0)
          && !closed.detailVisible && opened.detailVisible && !reclosed.detailVisible
          && [opened, reclosed].every(state => compare(closed.cards, state.cards) && compare(closed.columns, state.columns))
          && [closed, opened, reclosed].every(state => !state.pageOverflow);
        results.push({ width, layout, passed, closed, opened, reclosed });
      }
    }
  } finally {
    await viewport.reset();
    await tab.getAXState({ emit: false });
  }
  const crossLayout = widths.map(width => {
    const board = results.find(row => row.width === width && row.layout === "board");
    const grid = results.find(row => row.width === width && row.layout === "grid");
    if (!board || !grid) return { width, passed: true, skipped: true };
    const passed = ["closed", "opened", "reclosed"].every(state => {
      const gridWidth = grid[state].cards[0].width;
      return board[state].columns.every(column => Math.abs(column.width - gridWidth) < 1)
        && board[state].cards.every(card => Math.abs(gridWidth - card.width - 22) < 1);
    });
    return { width, passed };
  });
  if (results.some(result => !result.passed) || crossLayout.some(result => !result.passed))
    throw new Error(JSON.stringify({ passed: false, results, crossLayout }));
  return { passed: true, results, crossLayout };
}
