/**
 * Session + app context. Owns: language (localStorage), admin key
 * (sessionStorage — dies with the tab by design), and the derived
 * typed API client. Pages read everything from here; tests can inject
 * a stub client via the `client` prop.
 */

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import type { V3Client } from '@dropagentx/contracts';
import { type Lang, DIRS, DICTS, formatMessage, isLang, type I18nKey } from './i18n.js';
import { createDashboardClient } from './api.js';

const LANG_STORAGE_KEY = 'v3.lang';
const KEY_STORAGE_KEY = 'v3.adminKey';

function readLang(): Lang {
  try {
    const v = window.localStorage.getItem(LANG_STORAGE_KEY);
    if (isLang(v)) return v;
  } catch {
    /* storage disabled — default fa */
  }
  return 'fa';
}

function readAdminKey(): string | null {
  try {
    const v = window.sessionStorage.getItem(KEY_STORAGE_KEY);
    return v === null || v === '' ? null : v;
  } catch {
    return null;
  }
}

export interface SessionValue {
  readonly lang: Lang;
  readonly dir: 'rtl' | 'ltr';
  readonly adminKey: string | null;
  /** API root the derived client talks to (exposed so the gate can probe keys). */
  readonly baseUrl: string;
  readonly client: V3Client;
  readonly t: (key: I18nKey, params?: Record<string, string | number>) => string;
  readonly setLang: (lang: Lang) => void;
  readonly setAdminKey: (key: string | null) => void;
}

export interface SessionProviderProps {
  readonly children: ReactNode;
  /** Test seam — replaces the derived client entirely. */
  readonly client?: V3Client;
  /** Test seam — base URL behind the derived client. */
  readonly baseUrl?: string;
}

const SessionContext = createContext<SessionValue | null>(null);

export function SessionProvider({ children, client, baseUrl = '/api/v1' }: SessionProviderProps): React.JSX.Element {
  const [lang, setLangState] = useState<Lang>(readLang);
  const [adminKey, setAdminKeyState] = useState<string | null>(readAdminKey);

  useEffect(() => {
    const html = document.documentElement;
    html.lang = lang;
    html.dir = DIRS[lang];
  }, [lang]);

  const setLang = useCallback((next: Lang) => {
    setLangState(next);
    try {
      window.localStorage.setItem(LANG_STORAGE_KEY, next);
    } catch {
      /* ignore */
    }
  }, []);

  const setAdminKey = useCallback((key: string | null) => {
    setAdminKeyState(key);
    try {
      if (key === null) window.sessionStorage.removeItem(KEY_STORAGE_KEY);
      else window.sessionStorage.setItem(KEY_STORAGE_KEY, key);
    } catch {
      /* ignore */
    }
  }, []);

  const derived = useMemo(
    () => createDashboardClient({ baseUrl, adminKey }),
    [baseUrl, adminKey],
  );

  const t = useCallback(
    (key: I18nKey, params?: Record<string, string | number>): string => {
      const template = DICTS[lang][key];
      return params === undefined ? template : formatMessage(template, params);
    },
    [lang],
  );

  const value = useMemo<SessionValue>(
    () => ({
      lang,
      dir: DIRS[lang],
      adminKey,
      baseUrl,
      client: client ?? derived,
      t,
      setLang,
      setAdminKey,
    }),
    [lang, adminKey, baseUrl, client, derived, t, setLang, setAdminKey],
  );

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionValue {
  const ctx = useContext(SessionContext);
  if (ctx === null) throw new Error('useSession outside <SessionProvider>');
  return ctx;
}
