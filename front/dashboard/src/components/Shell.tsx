/**
 * Shell — RTL-aware chrome: brand header, sidebar nav (logical start side),
 * language toggle and admin session indicator. The sidebar collapses to a
 * horizontal chip row on small screens (mobile Lighthouse gate).
 */

import type { ReactNode } from 'react';
import { useSession } from '../lib/session.js';
import { navigate, useRoute, ROUTES, type RoutePath } from '../lib/router.js';
import type { I18nKey } from '../lib/i18n.js';
import { Badge } from './ui.js';

const NAV_ICONS: Record<RoutePath, string> = {
  '/overview': '◈',
  '/accounts': '◆',
  '/escrows': '⬡',
  '/hitl': '✋',
  '/settings': '⚙',
};

const NAV_LABEL: Record<RoutePath, I18nKey> = {
  '/overview': 'nav.overview',
  '/accounts': 'nav.accounts',
  '/escrows': 'nav.escrows',
  '/hitl': 'nav.hitl',
  '/settings': 'nav.settings',
};

const ADMIN_ROUTES: ReadonlySet<RoutePath> = new Set(['/accounts', '/escrows', '/hitl']);

export function Shell({ children }: { children: ReactNode }): React.JSX.Element {
  const { t, lang, setLang, adminKey } = useSession();
  const route = useRoute();

  const navItems = ROUTES.map((path) => {
    const locked = ADMIN_ROUTES.has(path) && adminKey === null;
    const active = route === path;
    return (
      <button
        key={path}
        type="button"
        onClick={() => navigate(path)}
        className={`flex w-full items-center gap-2.5 rounded-xl px-3 py-2.5 text-sm transition-colors ${
          active ? 'bg-white/10 font-bold text-ink' : 'text-ink-dim hover:bg-white/5 hover:text-slate-200'
        }`}
        aria-current={active ? 'page' : undefined}
      >
        <span className={active ? 'text-emerald-300' : 'text-slate-500'}>{NAV_ICONS[path]}</span>
        <span className="flex-1 text-start">{t(NAV_LABEL[path])}</span>
        {locked && <span className="text-[10px] text-amber-300/80">🔒</span>}
      </button>
    );
  });

  return (
    <div className="mx-auto flex min-h-screen w-full max-w-6xl flex-col px-4 pb-10 sm:px-6">
      <header className="flex flex-wrap items-center justify-between gap-3 py-5">
        <div className="flex items-center gap-3">
          <img
            src="/logo.png"
            alt="DropAgentX v3 logo"
            className="size-10 rounded-xl object-cover ring-1 ring-white/10"
          />
          <div>
            <h1 className="text-lg font-bold leading-tight">
              <span className="brand-gradient">{t('app.brand')}</span>
              <span className="text-slate-400"> v3</span>
            </h1>
            <p className="text-[11px] text-ink-dim">{t('app.tagline')}</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {adminKey !== null ? (
            <Badge tone="mint">admin</Badge>
          ) : (
            <Badge tone="neutral">{t('settings.keyUnset')}</Badge>
          )}
          <button
            type="button"
            onClick={() => setLang(lang === 'fa' ? 'en' : 'fa')}
            className="glass px-3 py-1.5 text-xs font-medium text-slate-200 transition-colors hover:bg-white/10"
            title="fa / en"
          >
            {lang === 'fa' ? 'EN' : 'فا'}
          </button>
        </div>
      </header>

      <div className="flex flex-1 flex-col gap-5 md:flex-row">
        <nav className="md:sticky md:top-5 md:h-fit md:w-56 md:shrink-0" aria-label="main">
          <div className="glass flex gap-2 overflow-x-auto p-2 md:flex-col md:overflow-visible">{navItems}</div>
        </nav>
        <main className="min-w-0 flex-1">{children}</main>
      </div>
    </div>
  );
}
