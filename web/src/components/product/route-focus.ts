import { useEffect, useRef } from "react";

export function useRouteContentFocus(pathname: string) {
  const contentRef = useRef<HTMLElement>(null);
  const previousPathnameRef = useRef(pathname);

  useEffect(() => {
    if (previousPathnameRef.current === pathname) return;
    previousPathnameRef.current = pathname;
    const frame = requestAnimationFrame(() => {
      const content = contentRef.current;
      if (!content || content.contains(document.activeElement)) return;
      content.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(frame);
  }, [pathname]);

  return contentRef;
}
