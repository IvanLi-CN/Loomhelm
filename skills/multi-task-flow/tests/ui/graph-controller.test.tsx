import { expect, mock, test } from 'bun:test';
import React, { act } from 'react';
import { createSingleDeliveryUnitLedger } from '../../examples/single-delivery-unit/ledger';
import { buildView } from '../../scripts/view';
import type { GraphContext } from '../../web/graph';
import type { GraphLayout } from '../../web/graph-layout';
import type { GraphProjection } from '../../web/graph-projection';
import type { View } from '../../web/model';

// Exercise the real controller/React root; only the canvas and async solver are replaced.
mock.module('@xyflow/react', () => ({
  ReactFlow: ({ nodes }: { nodes: { id: string; data: { state: string } }[] }) =>
    <div data-testid="canvas">{nodes.map(node => <span key={node.id} data-node={node.id}>{node.data.state}</span>)}</div>,
  BaseEdge: () => null, Handle: () => null,
  Position: { Bottom: 'bottom', Top: 'top', Right: 'right', Left: 'left' },
  MarkerType: { ArrowClosed: 'arrowclosed' },
}));
const { createGraphController } = await import('../../web/graph-view');

function placed(projection: GraphProjection): GraphLayout {
  return { nodes: projection.nodes.map((node, index) => ({ node, x: index * 200, y: 0, width: 184, height: 76 })), edges: [], width: 800, height: 200 };
}

test('pending projection refreshes deduplicate, retain latest state and reject stale results', async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true, requestAnimationFrame: (callback: FrameRequestCallback) => { callback(0); return 0; } });
  const view = buildView(createSingleDeliveryUnitLedger()) as View;
  const elements = new Map(['graph', 'graph-empty', 'graph-projection-warning', 'graph-a11y'].map(id => [id, document.createElement('div')]));
  const context: GraphContext = {
    element: id => elements.get(id)! as any, getData: () => view,
    getViewState: () => ({ zoom: 1 }), setZoom: () => {}, css: (_name, fallback) => fallback,
    stateColor: () => '#888', groupColor: () => '#888', getSelected: () => ({ task: null, group: null }),
    taskPreview: () => document.createElement('div'), groupPreview: () => document.createElement('div'),
    showHoverPreview: () => {}, hideHoverPreview: () => {}, recordPointerType: () => {}, selectTask: () => {}, selectGroup: () => {},
  };
  const requests: { projection: GraphProjection; resolve: (result: GraphLayout) => void }[] = [];
  let controller!: ReturnType<typeof createGraphController>;
  await act(async () => { controller = createGraphController(context, projection => new Promise(resolve => requests.push({ projection, resolve }))); controller.render(view.tasks); });
  await act(async () => { requests[0]!.resolve(placed(requests[0]!.projection)); });
  expect(elements.get('graph')!.querySelectorAll('[data-node]')).toHaveLength(requests[0]!.projection.nodes.length);
  const subset = view.tasks.slice(0, 2);
  await act(async () => { controller.render(subset); });
  expect(elements.get('graph')!.querySelectorAll('[data-node]')).toHaveLength(0);
  view.tasks.find(task => task.id === subset[0]!.id)!.state = 'running';
  await act(async () => { controller.render(subset); });
  expect(requests).toHaveLength(2);
  await act(async () => { requests[1]!.resolve(placed(requests[1]!.projection)); });
  expect(elements.get('graph')!.querySelector(`[data-node="${subset[0]!.id}"]`)?.textContent).toBe('执行中');
  expect(elements.get('graph')!.querySelectorAll('[data-node]')).toHaveLength(requests[1]!.projection.nodes.length);
  await act(async () => { controller.render(view.tasks.slice(0, 3)); controller.render(view.tasks.slice(0, 4)); });
  await act(async () => { requests[3]!.resolve(placed(requests[3]!.projection)); });
  const current = elements.get('graph')!.innerHTML;
  await act(async () => { requests[2]!.resolve(placed(requests[2]!.projection)); });
  expect(elements.get('graph')!.innerHTML).toBe(current);
});
