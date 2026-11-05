/**
 * HITL queue (admin) — charter Article 7. The dashboard is the human side:
 * approve (settlement runs atomically with the decision — 90/10 via the
 * domain) or reject, with a decider id + note for the audit trail. Sweep
 * marks overdue PENDING rows EXPIRED.
 */

import { useState } from 'react';
import { HITL_STATUSES, type HitlStatusWire, type HitlView } from '@dropagentx/contracts';
import { useSession } from '../lib/session.js';
import { bannerError, unwrap } from '../lib/api.js';
import { dateTime, din, timeLeft } from '../lib/format.js';
import { Banner, Button, Card, Empty, ErrorBanner, Field, HitlStatusBadge, useLoad } from '../components/ui.js';

const PENDING: HitlStatusWire = 'PENDING';

export function HitlPage(): React.JSX.Element {
  const { t, lang, client } = useSession();
  const [filter, setFilter] = useState<HitlStatusWire | null>(PENDING);
  const { data, error, loading, refresh } = useLoad(() => unwrap(client.listHitl(filter ?? undefined)), [client, filter]);

  const [decideId, setDecideId] = useState<string | null>(null);
  const [decidedBy, setDecidedBy] = useState('admin:dashboard');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [rowError, setRowError] = useState<(Error & { code?: string }) | null>(null);
  const [flash, setFlash] = useState<string | null>(null);
  const [sweepBusy, setSweepBusy] = useState(false);

  const items: HitlView[] = data?.items ?? [];
  const pendingCount = items.filter((i) => i.status === 'PENDING').length;

  const decide = async (id: string, decision: 'approve' | 'reject'): Promise<void> => {
    setBusy(true);
    setRowError(null);
    const res =
      decision === 'approve'
        ? await client.approveHitl(id, { decidedBy: decidedBy.trim() !== '' ? decidedBy.trim() : 'admin:dashboard', ...(note.trim() !== '' ? { note: note.trim() } : {}) })
        : await client.rejectHitl(id, { decidedBy: decidedBy.trim() !== '' ? decidedBy.trim() : 'admin:dashboard', ...(note.trim() !== '' ? { note: note.trim() } : {}) });
    setBusy(false);
    if (!res.ok) {
      setRowError(bannerError(res.error));
      return;
    }
    setFlash(
      decision === 'approve'
        ? res.value.txId !== null
          ? t('hitl.approved', { tx: res.value.txId })
          : t('hitl.approved', { tx: t('common.none') })
        : t('hitl.rejected'),
    );
    setDecideId(null);
    setNote('');
    refresh();
  };

  const sweep = async (): Promise<void> => {
    setSweepBusy(true);
    const res = await client.sweepHitl();
    setSweepBusy(false);
    if (res.ok) {
      setFlash(t('hitl.swept', { n: res.value.expired }));
      refresh();
    }
  };

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-bold">
            {t('hitl.title')} {pendingCount > 0 && <span className="text-amber-300">· {pendingCount}</span>}
          </h2>
          <p className="mt-0.5 text-xs text-ink-dim">{t('hitl.subtitle')}</p>
        </div>
        <div className="flex gap-2">
          <Button onClick={sweep} loading={sweepBusy}>
            {t('hitl.sweep')}
          </Button>
          <Button onClick={refresh} loading={loading}>
            {t('common.refresh')}
          </Button>
        </div>
      </div>

      {flash !== null && <Banner tone="mint">{flash}</Banner>}
      {rowError !== null && <ErrorBanner error={rowError} />}
      {error !== null && <ErrorBanner error={error} />}

      <Card>
        <div className="mb-4 flex flex-wrap gap-2">
          <Button variant={filter === null ? 'primary' : 'ghost'} onClick={() => setFilter(null)}>
            {t('common.all')}
          </Button>
          {HITL_STATUSES.map((s) => (
            <Button key={s} variant={filter === s ? 'primary' : 'ghost'} onClick={() => setFilter(s)}>
              {t(`hstatus.${s === 'EXPIRED' ? 'H_EXPIRED' : s}`)}
            </Button>
          ))}
        </div>

        {items.length === 0 && !loading ? (
          <Empty icon="✋" />
        ) : (
          <div className="scroll-thin overflow-x-auto">
            <table className="tbl">
              <thead>
                <tr>
                  <th>{t('hitl.id')}</th>
                  <th>{t('hitl.kind')}</th>
                  <th className="text-end">{t('hitl.amount')}</th>
                  <th>{t('hitl.requester')}</th>
                  <th>{t('hitl.status')}</th>
                  <th>{t('hitl.expiresAt')}</th>
                  <th>{t('common.actions')}</th>
                </tr>
              </thead>
              <tbody>
                {items.map((item) => (
                  <tr key={item.id} className={item.status === 'PENDING' ? 'bg-amber-400/[0.03]' : ''}>
                    <td className="font-mono text-xs" dir="ltr" title={item.id}>
                      {item.id.length > 18 ? `…${item.id.slice(-17)}` : item.id}
                    </td>
                    <td className="text-xs">{t(`hitl.kind.${item.kind}`)}</td>
                    <td className="text-end font-bold tabular-nums text-amber-300">{din(item.amount, lang)}</td>
                    <td className="font-mono text-xs" dir="ltr">
                      {item.requesterId.length > 16 ? `…${item.requesterId.slice(-15)}` : item.requesterId}
                    </td>
                    <td>
                      <HitlStatusBadge status={item.status} />
                    </td>
                    <td className="text-xs text-ink-dim">
                      {dateTime(item.expiresAt, lang)}
                      <span className="block text-[10px]">{timeLeft(item.expiresAt, lang)}</span>
                    </td>
                    <td>
                      {item.status === 'PENDING' ? (
                        <div className="flex gap-1.5">
                          <Button variant="primary" onClick={() => setDecideId(decideId === item.id ? null : item.id)}>
                            {t('hitl.decide')}
                          </Button>
                        </div>
                      ) : (
                        <span className="text-xs text-ink-dim">
                          {item.decidedBy ?? '—'}
                          {item.decidedAt !== null && (
                            <span className="block text-[10px]">{dateTime(item.decidedAt, lang)}</span>
                          )}
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {decideId !== null && (
        <Card title={t('hitl.decide')} subtitle={`${t('hitl.id')}: ${decideId}`} className="max-w-lg">
          <form
            className="flex flex-col gap-3"
            onSubmit={(e) => {
              e.preventDefault();
              void decide(decideId, 'approve');
            }}
          >
            <Field label={t('hitl.decidedBy')}>
              <input className="inp font-mono" dir="ltr" value={decidedBy} onChange={(e) => setDecidedBy(e.target.value)} />
            </Field>
            <Field label={t('hitl.decisionNote')}>
              <textarea className="inp min-h-16" value={note} onChange={(e) => setNote(e.target.value)} />
            </Field>
            <div className="flex gap-2">
              <Button type="submit" variant="primary" loading={busy}>
                {t('hitl.approve')}
              </Button>
              <Button variant="danger" loading={busy} onClick={() => void decide(decideId, 'reject')}>
                {t('hitl.reject')}
              </Button>
              <Button onClick={() => setDecideId(null)}>{t('common.cancel')}</Button>
            </div>
          </form>
        </Card>
      )}
    </div>
  );
}
