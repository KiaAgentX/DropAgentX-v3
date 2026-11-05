/**
 * Accounts (admin) — wallet list + create + mint/burn.
 * Mint/burn show a confirm step: money creation/destruction is the most
 * charter-sensitive action in the whole product (Articles 1–3).
 */

import { useState } from 'react';
import type { AccountView } from '@dropagentx/contracts';
import { useSession } from '../lib/session.js';
import { bannerError, unwrap } from '../lib/api.js';
import { dateTime, din, num, shortId } from '../lib/format.js';
import { Banner, Button, Card, Empty, ErrorBanner, Field, useLoad } from '../components/ui.js';

export function AccountsPage(): React.JSX.Element {
  const { t, lang, client } = useSession();
  const { data, error, loading, refresh } = useLoad(() => unwrap(client.listAccounts()), [client]);

  const [newId, setNewId] = useState('');
  const [newLabel, setNewLabel] = useState('');
  const [formError, setFormError] = useState<Error & { code?: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [flash, setFlash] = useState<string | null>(null);

  // mint/burn form
  const [moveKind, setMoveKind] = useState<'mint' | 'burn' | null>(null);
  const [moveAccount, setMoveAccount] = useState('');
  const [moveAmount, setMoveAmount] = useState('');
  const [moveMemo, setMoveMemo] = useState('');
  const [moveBusy, setMoveBusy] = useState(false);

  const accounts: AccountView[] = data?.items ?? [];
  const userAccounts = accounts.filter((a) => a.kind === 'user');

  const createAccount = async (): Promise<void> => {
    setBusy(true);
    setFormError(null);
    const res = await client.createAccount({ id: newId.trim(), ...(newLabel.trim() !== '' ? { label: newLabel.trim() } : {}) });
    setBusy(false);
    if (!res.ok) {
      setFormError(bannerError(res.error));
      return;
    }
    setFlash(t('accounts.createdOk', { id: res.value.id }));
    setNewId('');
    setNewLabel('');
    refresh();
  };

  const submitMove = async (): Promise<void> => {
    const amount = Number(moveAmount);
    if (moveKind === null || moveAccount === '' || !Number.isInteger(amount) || amount <= 0) return;
    setMoveBusy(true);
    setFormError(null);
    const memo = moveMemo.trim();
    const res =
      moveKind === 'mint'
        ? await client.mint({ accountId: moveAccount, amount, ...(memo !== '' ? { memo } : {}) })
        : await client.burn({ accountId: moveAccount, amount, ...(memo !== '' ? { memo } : {}) });
    setMoveBusy(false);
    if (!res.ok) {
      setFormError(bannerError(res.error));
      return;
    }
    setFlash(
      moveKind === 'mint'
        ? t('accounts.minted', { amount: din(amount, lang), id: moveAccount })
        : t('accounts.burned', { amount: din(amount, lang), id: moveAccount }),
    );
    setMoveKind(null);
    setMoveAmount('');
    setMoveMemo('');
    refresh();
  };

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-bold">{t('accounts.title')}</h2>
          <p className="mt-0.5 text-xs text-ink-dim">{t('accounts.subtitle')}</p>
        </div>
        <Button onClick={refresh} loading={loading}>
          {t('common.refresh')}
        </Button>
      </div>

      {flash !== null && <Banner tone="mint">{flash}</Banner>}
      {formError !== null && <ErrorBanner error={formError} />}
      {error !== null && <ErrorBanner error={error} />}

      <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
        <Card title={t('accounts.createTitle')}>
          <form
            className="flex flex-col gap-3"
            onSubmit={(e) => {
              e.preventDefault();
              void createAccount();
            }}
          >
            <Field label={t('accounts.newId')}>
              <input className="inp font-mono" dir="ltr" value={newId} onChange={(e) => setNewId(e.target.value)} placeholder="user:tg:123456" />
            </Field>
            <Field label={t('accounts.newLabel')}>
              <input className="inp" value={newLabel} onChange={(e) => setNewLabel(e.target.value)} />
            </Field>
            <Button type="submit" variant="primary" loading={busy} disabled={newId.trim().length < 1}>
              {t('common.create')}
            </Button>
            <p className="text-[11px] leading-relaxed text-ink-dim">{t('accounts.systemHint')}</p>
          </form>
        </Card>

        <Card title={moveKind === 'mint' ? t('accounts.mintTitle') : t('accounts.burnTitle')}>
          {moveKind === null ? (
            <div className="flex gap-2">
              <Button variant="primary" onClick={() => setMoveKind('mint')}>
                ＋ {t('accounts.mint')}
              </Button>
              <Button variant="danger" onClick={() => setMoveKind('burn')}>
                － {t('accounts.burn')}
              </Button>
            </div>
          ) : (
            <form
              className="flex flex-col gap-3"
              onSubmit={(e) => {
                e.preventDefault();
                void submitMove();
              }}
            >
              <Field label={t('accounts.pickAccount')}>
                <select className="inp" dir="ltr" value={moveAccount} onChange={(e) => setMoveAccount(e.target.value)}>
                  <option value="" disabled>
                    —
                  </option>
                  {accounts.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.id} ({a.balance})
                    </option>
                  ))}
                </select>
              </Field>
              <Field label={t('accounts.amount')}>
                <input
                  className="inp tabular-nums"
                  dir="ltr"
                  inputMode="numeric"
                  value={moveAmount}
                  onChange={(e) => setMoveAmount(e.target.value.replace(/[^\d]/g, ''))}
                />
              </Field>
              <Field label={t('accounts.memo')}>
                <input className="inp" value={moveMemo} onChange={(e) => setMoveMemo(e.target.value)} />
              </Field>
              <div className="flex gap-2">
                <Button
                  type="submit"
                  variant={moveKind === 'mint' ? 'primary' : 'danger'}
                  loading={moveBusy}
                  disabled={moveAccount === '' || moveAmount === ''}
                >
                  {moveKind === 'mint' ? t('accounts.mint') : t('accounts.burn')}
                </Button>
                <Button onClick={() => setMoveKind(null)}>{t('common.cancel')}</Button>
              </div>
            </form>
          )}
        </Card>
      </div>

      <Card>
        {accounts.length === 0 && !loading ? (
          <Empty />
        ) : (
          <div className="scroll-thin overflow-x-auto">
            <table className="tbl">
              <thead>
                <tr>
                  <th>{t('accounts.id')}</th>
                  <th>{t('accounts.kind')}</th>
                  <th>{t('accounts.label')}</th>
                  <th className="text-end">{t('accounts.balance')}</th>
                  <th>{t('accounts.created')}</th>
                </tr>
              </thead>
              <tbody>
                {accounts.map((a) => (
                  <tr key={a.id}>
                    <td className="font-mono text-xs" dir="ltr" title={a.id}>
                      {shortId(a.id)}
                    </td>
                    <td>
                      <span className={a.kind === 'user' ? 'text-emerald-300' : 'text-violet-300'}>{a.kind}</span>
                    </td>
                    <td className="text-ink-dim">{a.label ?? '—'}</td>
                    <td className={`text-end font-bold tabular-nums ${a.balance > 0 ? 'text-emerald-300' : ''}`}>{num(a.balance, lang)}</td>
                    <td className="text-xs text-ink-dim">{dateTime(a.createdAt, lang)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
      {userAccounts.length === 0 && accounts.length > 0 && (
        <p className="text-center text-xs text-ink-dim">{t('accounts.subtitle')}</p>
      )}
    </div>
  );
}
