/**
 * Integration point for readable content renderers.
 * Concrete content kinds and rendering rules remain a later product contract.
 */
export type ContentRenderer<TContent = unknown, TOutput = unknown> = (
  content: TContent
) => TOutput;
