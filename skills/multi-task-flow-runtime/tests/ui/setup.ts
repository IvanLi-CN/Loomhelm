import { Window } from "happy-dom";

const dom = new Window({ url: "http://localhost/" });

Object.assign(globalThis, {
  window: dom,
  document: dom.document,
  HTMLElement: dom.HTMLElement,
  HTMLButtonElement: dom.HTMLButtonElement,
  DOMRect: dom.DOMRect,
  Event: dom.Event,
  Node: dom.Node,
});
