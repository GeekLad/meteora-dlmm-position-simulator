/**
 * Next.js's dev overlay treats every console.error as an app crash.
 * Browser extensions inject scripts that log errors we cannot fix.
 * Swallow those so they don't cover the simulator.
 */

const EXTENSION_HINT = /(?:chrome|moz|safari|safari-web)-extension:\/\//i;
const FILTER_MARK = '__dlmmIgnoreExtensionErrors';

function isExtensionText(value: unknown): boolean {
  return typeof value === 'string' && EXTENSION_HINT.test(value);
}

function isExtensionNoise(args: unknown[]): boolean {
  if (isExtensionText(new Error().stack)) return true;

  for (const arg of args) {
    if (isExtensionText(arg)) return true;
    if (arg instanceof Error && isExtensionText(arg.stack)) return true;
  }

  // React replayed server logs use `%c%s%c ...` with an environment label.
  // Next.js misreads some extension logs (e.g. label "Chrome Version") as that.
  if (
    args.length > 3
    && typeof args[0] === 'string'
    && args[0].startsWith('%c%s%c ')
    && typeof args[2] === 'string'
    && /chrome/i.test(args[2])
  ) {
    return true;
  }

  return false;
}

function installConsoleFilter() {
  const current = console.error as typeof console.error & { [FILTER_MARK]?: boolean };
  if (current[FILTER_MARK]) return;

  const wrapped = (...args: unknown[]) => {
    if (isExtensionNoise(args)) return;
    current.apply(console, args);
  };
  (wrapped as typeof wrapped & { [FILTER_MARK]?: boolean })[FILTER_MARK] = true;
  console.error = wrapped as typeof console.error;
}

function isExtensionEvent(filename: string | undefined, error: unknown): boolean {
  if (filename && EXTENSION_HINT.test(filename)) return true;
  if (error instanceof Error && isExtensionText(error.stack)) return true;
  if (isExtensionText(error)) return true;
  return false;
}

let eventsInstalled = false;

function installEventFilters() {
  if (eventsInstalled || typeof window === 'undefined') return;
  eventsInstalled = true;
  window.addEventListener(
    'error',
    (event) => {
      if (!isExtensionEvent(event.filename, event.error)) return;
      event.preventDefault();
      event.stopImmediatePropagation();
    },
    true
  );
  window.addEventListener(
    'unhandledrejection',
    (event) => {
      if (!isExtensionEvent(undefined, event.reason)) return;
      event.preventDefault();
      event.stopImmediatePropagation();
    },
    true
  );
}

export function ignoreExtensionErrors() {
  if (typeof window === 'undefined') return;
  installEventFilters();
  installConsoleFilter();
  for (const ms of [0, 50, 200]) {
    window.setTimeout(installConsoleFilter, ms);
  }
}
