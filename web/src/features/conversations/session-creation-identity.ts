const SESSION_CREATION_INTENT_PREFIX = "loomhelm:session-creation-intent:";
const BROWSER_CONTEXT_NAME_PREFIX = "loomhelm:browser-context:";
let browserContextId: string | undefined;

function createBrowserContextId(): string {
  if (typeof globalThis.crypto?.randomUUID === "function") return `browser-${globalThis.crypto.randomUUID()}`;
  return `browser-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

function getBrowserContextId(): string | undefined {
  if (typeof window === "undefined") return undefined;
  if (browserContextId) return browserContextId;

  const existingName = window.name.startsWith(BROWSER_CONTEXT_NAME_PREFIX) ? window.name.slice(BROWSER_CONTEXT_NAME_PREFIX.length) : "";
  if (existingName) {
    browserContextId = existingName;
    return browserContextId;
  }

  const nextId = createBrowserContextId();
  try {
    window.name = `${BROWSER_CONTEXT_NAME_PREFIX}${nextId}`;
  } catch {
    // The context can still be isolated for this page lifetime when window.name is unavailable.
  }
  browserContextId = nextId;
  return browserContextId;
}

function getIdentityScope(principalId: string | undefined): string {
  return encodeURIComponent(principalId?.trim() || "anonymous");
}

export function buildSessionCreationIntentKey({
  browserContext,
  conversationTitle,
  pathname,
  principalId,
  projectId,
  taskId
}: {
  browserContext: string;
  conversationTitle: string;
  pathname: string;
  principalId?: string;
  projectId?: string;
  taskId?: string;
}): string {
  return `${SESSION_CREATION_INTENT_PREFIX}${getIdentityScope(principalId)}:${encodeURIComponent(browserContext)}:${encodeURIComponent([pathname, conversationTitle, taskId ?? "", projectId ?? ""].join("|"))}`;
}

export function getSessionCreationIntentKey(principalId: string | undefined, conversationTitle: string, taskId?: string, projectId?: string): string | undefined {
  if (typeof window === "undefined") return undefined;
  const browserContext = getBrowserContextId();
  return browserContext ? buildSessionCreationIntentKey({ browserContext, conversationTitle, pathname: window.location.pathname, principalId, projectId, taskId }) : undefined;
}
