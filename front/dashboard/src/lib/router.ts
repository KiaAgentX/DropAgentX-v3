/**
 * Minimal hash router — no dependency. Hash routing keeps the SPA deployable
 * as static files straight out of Fastify (Phase 6 single service) with zero
 * rewrite rules, and works identically in RTL and LTR.
 */

import { useSyncExternalStore } from 'react';

export type RoutePath = '/overview' | '/accounts' | '/escrows' | '/hitl' | '/settings';

export const ROUTES: readonly RoutePath[] = ['/overview', '/accounts', '/escrows', '/hitl', '/settings'];

export const DEFAULT_ROUTE: RoutePath = '/overview';

function parse(hash: string): RoutePath {
  const raw = hash.replace(/^#/, '') || DEFAULT_ROUTE;
  const candidate = (raw.startsWith('/') ? raw : `/${raw}`) as RoutePath;
  return ROUTES.includes(candidate) ? candidate : DEFAULT_ROUTE;
}

function subscribe(cb: () => void): () => void {
  window.addEventListener('hashchange', cb);
  return () => window.removeEventListener('hashchange', cb);
}

function current(): RoutePath {
  return parse(window.location.hash);
}

export function useRoute(): RoutePath {
  return useSyncExternalStore(subscribe, current, () => DEFAULT_ROUTE);
}

export function navigate(path: RoutePath): void {
  if (window.location.hash === `#${path}`) return;
  window.location.hash = path;
}
