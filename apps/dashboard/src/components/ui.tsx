/**
 * UI kit — Aurora glass primitives. All spacing/colors are logical-CSS so
 * RTL and LTR render identically (Phase-4 acceptance: RTL without breakage).
 */

import type { ReactNode } from 'react';
import { useEffect, useState } from 'react';
import type { EscrowStatusWire, HitlStatusWire } from '@dropagentx/contracts';
import { useSession } from '../lib/session.js';
import { errorKey as wireErrorKey, isMappedErrorCode } from '../lib/api.js';

/* ── tone system ────────────────────────────────────────────────────── */

export type Tone = 'neutral' | 'mint' | 'cyan' | 'violet' | 'amber' | 'red';

const TONE_TEXT: Record<Tone, string> = {
  neutral: 'text-slate-300',
  mint: 'text-emerald-300',
  cyan: 'text-cyan-300',
  violet: 'text-violet-300',
  amber: 'text-amber-300',
  red: 'text-red-300',
};

const TONE_BG: Record<Tone, string> = {
  neutral: 'bg-white/10',
  mint: 'bg-emerald-400/15',
  cyan: 'bg-cyan-400/15',
  violet: 'bg-violet-400/15',
  amber: 'bg-amber-400/15',
  red: 'bg-red-400/15',
};

/* ── primitives ─────────────────────────────────────────────────────── */

export function Badge({ tone = 'neutral', children }: { tone?: Tone; children: ReactNode }): React.JSX.Element {
  return (
    <span className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ${TONE_BG[tone]} ${TONE_TEXT[tone]}`}>
      {children}
    </span>
  );
}

const ESCROW_TONES: Record<EscrowStatusWire, Tone> = {
  CREATED: 'neutral',
  FUNDED: 'cyan',
  DELIVERED: 'violet',
  RELEASED: 'mint',
  DISPUTED: 'amber',
  REFUNDED: 'red',
  CANCELLED: 'neutral',
  EXPIRED: 'neutral',
};

export function EscrowStatusBadge({ status }: { status: EscrowStatusWire }): React.JSX.Element {
  const { t } = useSession();
  return <Badge tone={ESCROW_TONES[status]}>{t(`status.${status}`)}</Badge>;
}

const HITL_TONES: Record<HitlStatusWire, Tone> = {
  PENDING: 'amber',
  APPROVED: 'mint',
  REJECTED: 'red',
  EXPIRED: 'neutral',
};

export function HitlStatusBadge({ status }: { status: HitlStatusWire }): React.JSX.Element {
  const { t } = useSession();
  return <Badge tone={HITL_TONES[status]}>{t(`hstatus.${status === 'EXPIRED' ? 'H_EXPIRED' : status}`)}</Badge>;
}

export function Card({
  title,
  subtitle,
  actions,
  children,
  className = '',
}: {
  title?: string;
  subtitle?: string;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
}): React.JSX.Element {
  return (
    <section className={`glass p-5 ${className}`}>
      {(title !== undefined || actions !== undefined) && (
        <header className="mb-4 flex flex-wrap items-start justify-between gap-3">
          <div>
            {title !== undefined && <h2 className="text-base font-bold text-ink">{title}</h2>}
            {subtitle !== undefined && <p className="mt-1 text-xs text-ink-dim">{subtitle}</p>}
          </div>
          {actions !== undefined && <div className="flex items-center gap-2">{actions}</div>}
        </header>
      )}
      {children}
    </section>
  );
}

export function Stat({
  label,
  value,
  hint,
  tone = 'neutral',
}: {
  label: string;
  value: string;
  hint?: string;
  tone?: Tone;
}): React.JSX.Element {
  return (
    <div className="glass p-4">
      <p className="text-xs text-ink-dim">{label}</p>
      <p className={`mt-1.5 text-xl font-bold tabular-nums ${TONE_TEXT[tone]}`}>{value}</p>
      {hint !== undefined && <p className="mt-1 text-[11px] text-ink-dim">{hint}</p>}
    </div>
  );
}

export function Button({
  variant = 'ghost',
  loading = false,
  disabled = false,
  onClick,
  type = 'button',
  children,
  title,
}: {
  variant?: 'primary' | 'ghost' | 'danger';
  loading?: boolean;
  disabled?: boolean;
  onClick?: () => void;
  type?: 'button' | 'submit';
  children: ReactNode;
  title?: string;
}): React.JSX.Element {
  const base =
    'inline-flex items-center justify-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-40';
  const styles: Record<string, string> = {
    primary: 'bg-emerald-400/20 text-emerald-300 hover:bg-emerald-400/30 border border-emerald-400/30',
    ghost: 'bg-white/5 text-slate-200 hover:bg-white/10 border border-white/10',
    danger: 'bg-red-400/15 text-red-300 hover:bg-red-400/25 border border-red-400/30',
  };
  return (
    <button type={type} className={`${base} ${styles[variant]}`} onClick={onClick} disabled={disabled || loading} title={title}>
      {loading && <Spinner />}
      {children}
    </button>
  );
}

export function Spinner(): React.JSX.Element {
  return (
    <span
      aria-hidden
      className="inline-block size-3 shrink-0 animate-spin rounded-full border-2 border-current border-t-transparent"
    />
  );
}

export function Banner({ tone = 'amber', children }: { tone?: Tone; children: ReactNode }): React.JSX.Element {
  return (
    <div
      role="alert"
      className={`mb-4 flex items-start gap-2 rounded-xl border px-4 py-3 text-xs leading-relaxed ${
        tone === 'red'
          ? 'border-red-400/30 bg-red-400/10 text-red-200'
          : tone === 'mint'
            ? 'border-emerald-400/30 bg-emerald-400/10 text-emerald-200'
            : 'border-amber-400/30 bg-amber-400/10 text-amber-100'
      }`}
    >
      {children}
    </div>
  );
}

export function Empty({ icon = '◌' }: { icon?: string }): React.JSX.Element {
  const { t } = useSession();
  return (
    <div className="py-10 text-center">
      <p className="text-3xl text-slate-600">{icon}</p>
      <p className="mt-2 text-sm font-medium text-ink-dim">{t('common.empty')}</p>
      <p className="mt-1 text-xs text-slate-500">{t('common.emptyHint')}</p>
    </div>
  );
}

export function Field({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}): React.JSX.Element {
  return (
    <label className="block">
      <span className="mb-1 block text-xs text-ink-dim">{label}</span>
      {children}
    </label>
  );
}

/** Error banner that maps wire errors to friendly copy, with raw code shown small. */
export function ErrorBanner({ error, extra }: { error: Error & { code?: string }; extra?: string }): React.JSX.Element {
  const { t } = useSession();
  const [showRaw, setShowRaw] = useState(false);
  const code = error.code;
  const friendly = code !== undefined && isMappedErrorCode(code) ? t(wireErrorKey({ code, message: error.message })) : t('err.GENERIC');
  return (
    <Banner tone="red">
      <div>
        <p>{friendly}</p>
        {extra !== undefined && <p className="mt-1 opacity-80">{extra}</p>}
        <button
          type="button"
          className="mt-1.5 underline decoration-dotted opacity-60 hover:opacity-100"
          onClick={() => setShowRaw((v) => !v)}
        >
          {error.code ?? 'NETWORK'}
        </button>
        {showRaw && <p className="mt-1 opacity-70">{error.message}</p>}
      </div>
    </Banner>
  );
}

/** Fetch-on-mount hook with manual refresh; uniform loading/error state for pages. */
export function useLoad<T>(load: () => Promise<T>, deps: readonly unknown[]): {
  data: T | null;
  error: (Error & { code?: string }) | null;
  loading: boolean;
  refresh: () => void;
} {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<(Error & { code?: string }) | null>(null);
  const [loading, setLoading] = useState(true);
  const [tick, setTick] = useState(0);
  const refresh = () => setTick((v) => v + 1);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError(null);
    load()
      .then((v: T) => {
        if (alive) {
          setData(v);
          setLoading(false);
        }
      })
      .catch((e: Error & { code?: string }) => {
        if (alive) {
          setError(e);
          setLoading(false);
        }
      });
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, tick]);

  return { data, error, loading, refresh };
}
