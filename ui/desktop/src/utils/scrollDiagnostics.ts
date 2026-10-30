// Temporary instrumentation for scroll/viewport investigations. Off unless
// the user enables Settings -> App -> Debug logging (the `debugLogging`
// setting), so no logging work runs on the normal scroll path.
//
// Entries go to the renderer console and the main log (via
// window.electron.logInfo) and are kept in a ring buffer:
//   window.__gooseScrollDiag.dump()   // returns the buffer as text
//   window.__gooseScrollDiag.clear()
//   window.__gooseScrollDiag.enable() / .disable()

const MAX_ENTRIES = 500;

interface ScrollDiagApi {
  dump: () => string;
  clear: () => void;
  enable: () => void;
  disable: () => void;
}

let enabled = false;
const entries: string[] = [];
const lastLogAt = new Map<string, number>();
let startedAt = performance.now();

export function configureScrollDiagnostics(value: boolean): void {
  if (enabled === value) return;
  enabled = value;
  entries.length = 0;
  lastLogAt.clear();
  startedAt = performance.now();
}

export function scrollDiagnosticsEnabled(): boolean {
  return enabled;
}

function record(line: string): void {
  entries.push(line);
  if (entries.length > MAX_ENTRIES) entries.splice(0, entries.length - MAX_ENTRIES);
  console.log(line);
  try {
    window.electron?.logInfo?.(line);
  } catch {
    // Logging must never break the scroll path.
  }
}

function formatDetail(detail?: Record<string, unknown>): string {
  if (!detail) return '';
  const parts: string[] = [];
  for (const [key, value] of Object.entries(detail)) {
    if (value === undefined) continue;
    parts.push(`${key}=${typeof value === 'number' ? Math.round(value * 10) / 10 : value}`);
  }
  return parts.length > 0 ? ` ${parts.join(' ')}` : '';
}

export function logScrollMark(event: string, detail?: Record<string, unknown>): void {
  if (!enabled) return;
  const elapsed = Math.round(performance.now() - startedAt);
  record(`[ScrollDiag] +${elapsed}ms ${event}${formatDetail(detail)}`);
}

export function logScroll(
  event: string,
  viewport: HTMLElement | null | undefined,
  detail?: Record<string, unknown>
): void {
  if (!enabled) return;
  const elapsed = Math.round(performance.now() - startedAt);
  let geometry = '';
  if (viewport) {
    const top = viewport.scrollTop;
    const height = viewport.scrollHeight;
    const client = viewport.clientHeight;
    geometry = ` top=${top} height=${height} client=${client} dist=${height - top - client}`;
  }
  record(`[ScrollDiag] +${elapsed}ms ${event}${geometry}${formatDetail(detail)}`);
}

/** For per-scroll-event call sites: keeps the main log readable. */
export function logScrollThrottled(
  event: string,
  viewport: HTMLElement | null | undefined,
  detail?: Record<string, unknown>,
  withinMs = 120
): void {
  if (!enabled) return;
  const now = performance.now();
  const last = lastLogAt.get(event) ?? -Infinity;
  if (now - last < withinMs) return;
  lastLogAt.set(event, now);
  logScroll(event, viewport, detail);
}

function installGlobal(): void {
  if (typeof window === 'undefined') return;
  const target = window as unknown as { __gooseScrollDiag?: ScrollDiagApi };
  if (target.__gooseScrollDiag) return;
  target.__gooseScrollDiag = {
    dump: () => entries.join('\n'),
    clear: () => {
      entries.length = 0;
    },
    enable: () => configureScrollDiagnostics(true),
    disable: () => configureScrollDiagnostics(false),
  };
}

installGlobal();
