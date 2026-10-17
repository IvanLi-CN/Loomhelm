/**
 * Generic JSON boundary for future generated protocol types.
 * No public event or command shape is defined by the frontend foundation.
 */
export type ProtocolValue =
  | boolean
  | null
  | number
  | ProtocolValue[]
  | { readonly [key: string]: ProtocolValue }
  | string;
