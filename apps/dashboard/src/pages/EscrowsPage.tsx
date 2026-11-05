/**
 * Escrows (admin) — the 8-state machine from HTTP. Lifecycle buttons are
 * computed from the current status; releases ≥ 50,000 Đ are refused by the
 * domain (REQUIRES_HUMAN_APPROVAL) and the UI routes the admin to the
 * HITL queue instead of bypassing the charter.
 */

import { Fragment, useState } from 'react';
import { ESCROW_STATUSES, type EscrowStatusWire, type EscrowView } from '@dropagentx/contracts';
import { useSession } from '../lib/session.js';
import { bannerError, unwrap } from '../lib/api.js';
import { dateTime, din, shortId } from '../lib/format.js';
import { navigate } from '../lib/router.js';
import type { I18nKey } from '../lib/i18n.js';
import { Banner, Button, Card, Empty, ErrorBanner, EscrowStatusBadge, Field, useLoad } from '../components/ui.js';

type EscrowAction = 'fund' | 'deliver' | 'release' | 'dispute' | 'refund' | 'cancel' | 'expire';

/** Action buttons valid per state — mirrors the domain's ESCROW_TRANSITIONS. */
function actionsFor(status: EscrowStatusWire): EscrowAction[] {
  switch (status) {
    case 'CREATED':
      return ['fund', 'cancel'];
    case 'FUNDED':
      return ['deliver', 'dispute', 'refund', 'expire'];
    case 'DELIVERED':
      return ['release', 'dispute', 'refund'];
    case 'DISPUTED':
      return ['refund', 'release'];
    default:
      return [];
  }
}

const ACTION_LABEL: Record<EscrowAction, I18nKey> = {
  fund: 'escrows.fund',
  deliver: 'escrows.deliver',
  release: 'escrows.release',
  dispute: 'escrows.dispute',
  refund: 'escrows.refund',
  cancel: 'escrows.cancel',
  expire: 'escrows.expire',
};

export function EscrowsPage(): React.JSX.Element {
  const { t, lang, client } = useSession();
  const [filter, setFilter] = useState<EscrowStatusWire | null>(null);
  const { data, error, loading, refresh } = useLoad(() => unwrap(client.listEscrows(filter ?? undefined)), [client, filter]);

  // create form
  const [buyer, setBuyer] = useState('');
  const [seller, setSeller] = useState('');
  const [amount, setAmount] = useState('');
  const [productRef, setProductRef] = useState('');
  const [formError, setFormError] = useState<(Error & { code?: string }) | null>(null);
  const [flash, setFlash] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // row actions
  const [expanded, setExpanded] = useState<string | null>(null);
  const [disputeReason, setDisputeReason] = useState('');
  const [rowBusy, setRowBusy] = useState<string | null>(null);
  const [rowError, setRowError] = useState<{ id: string; error: Error & { code?: string } } | null>(null);
  const [hitlHint, setHitlHint] = useState(false);

  const escrows: EscrowView[] = data?.items ?? [];

  const createEscrow = async (): Promise<void> => {
    const amt = Number(amount);
    if (!Number.isInteger(amt) || amt <= 0 || buyer.trim() === '' || seller.trim() === '') return;
    setBusy(true);
    setFormError(null);
    setFlash(null);
    const id = `escrow:dash-${Date.now().toString(36)}`;
    const res = await client.createEscrow({
      id,
      buyerId: buyer.trim(),
      sellerId: seller.trim(),
      amount: amt,
      ...(productRef.trim() !== '' ? { productRef: productRef.trim() } : {}),
    });
    setBusy(false);
    if (!res.ok) {
      setFormError(bannerError(res.error));
      return;
    }
    setFlash(t('escrows.createdOk', { id: res.value.escrow.id }));
    setBuyer('');
    setSeller('');
    setAmount('');
    setProductRef('');
    refresh();
  };

  const runAction = async (esc: EscrowView, action: EscrowAction): Promise<void> => {
    setRowBusy(esc.id);
    setRowError(null);
    setHitlHint(false);
    // Deterministic per (action, escrow, state): a double-click REPLAYS (no-op)
    // instead of moving money twice — the domain's idempotency discipline.
    const idem = `dash:${action}:${esc.id}:${esc.status}`.slice(0, 128);
    const res = await (async () => {
      switch (action) {
        case 'fund':
          return client.fundEscrow(esc.id, { idempotencyKey: idem });
        case 'deliver':
          return client.deliverEscrow(esc.id, { deliveryRef: `dash:${esc.id}`.slice(0, 256), idempotencyKey: idem });
        case 'release':
          return client.releaseEscrow(esc.id, { idempotencyKey: idem });
        case 'dispute':
          return client.disputeEscrow(esc.id, { reason: disputeReason.trim() !== '' ? disputeReason.trim() : 'dashboard dispute', idempotencyKey: idem });
        case 'refund':
          return client.refundEscrow(esc.id, { idempotencyKey: idem });
        case 'cancel':
          return client.cancelEscrow(esc.id, { idempotencyKey: idem });
        case 'expire':
          return client.expireEscrow(esc.id, { idempotencyKey: idem });
        default:
          return null;
      }
    })();
    setRowBusy(null);
    if (res === null) return;
    if (!res.ok) {
      if (res.error.code === 'REQUIRES_HUMAN_APPROVAL') {
        setHitlHint(true);
        setRowError({ id: esc.id, error: bannerError(res.error) });
        return;
      }
      setRowError({ id: esc.id, error: bannerError(res.error) });
      return;
    }
    setFlash(t('escrows.actionOk', { action: t(ACTION_LABEL[action]!), tx: res.value.txId ?? t('common.none') }));
    setExpanded(null);
    setDisputeReason('');
    refresh();
  };

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-bold">{t('escrows.title')}</h2>
          <p className="mt-0.5 text-xs text-ink-dim">{t('escrows.subtitle')}</p>
        </div>
        <Button onClick={refresh} loading={loading}>
          {t('common.refresh')}
        </Button>
      </div>

      {flash !== null && <Banner tone="mint">{flash}</Banner>}
      {hitlHint && (
        <Banner tone="amber">
          <span>
            {t('escrows.hitlHint')}{' '}
            <button type="button" className="underline" onClick={() => navigate('/hitl')}>
              {t('nav.hitl')} →
            </button>
          </span>
        </Banner>
      )}
      {formError !== null && <ErrorBanner error={formError} />}
      {error !== null && <ErrorBanner error={error} />}

      <Card title={t('escrows.newTitle')}>
        <form
          className="grid grid-cols-2 gap-3 sm:grid-cols-5"
          onSubmit={(e) => {
            e.preventDefault();
            void createEscrow();
          }}
        >
          <Field label={t('escrows.buyerId')}>
            <input className="inp font-mono" dir="ltr" value={buyer} onChange={(e) => setBuyer(e.target.value)} />
          </Field>
          <Field label={t('escrows.sellerId')}>
            <input className="inp font-mono" dir="ltr" value={seller} onChange={(e) => setSeller(e.target.value)} />
          </Field>
          <Field label={t('escrows.amount')}>
            <input
              className="inp tabular-nums"
              dir="ltr"
              inputMode="numeric"
              value={amount}
              onChange={(e) => setAmount(e.target.value.replace(/[^\d]/g, ''))}
            />
          </Field>
          <Field label={t('escrows.productRef')}>
            <input className="inp" dir="ltr" value={productRef} onChange={(e) => setProductRef(e.target.value)} />
          </Field>
          <div className="flex items-end">
            <Button type="submit" variant="primary" loading={busy} disabled={buyer === '' || seller === '' || amount === ''}>
              {t('common.create')}
            </Button>
          </div>
        </form>
      </Card>

      <Card title={t('escrows.filter')}>
        <div className="flex flex-wrap gap-2">
          <Button variant={filter === null ? 'primary' : 'ghost'} onClick={() => setFilter(null)}>
            {t('common.all')}
          </Button>
          {ESCROW_STATUSES.map((s) => (
            <Button key={s} variant={filter === s ? 'primary' : 'ghost'} onClick={() => setFilter(s)}>
              {t(`status.${s}`)}
            </Button>
          ))}
        </div>
      </Card>

      <Card>
        {escrows.length === 0 && !loading ? (
          <Empty icon="⬡" />
        ) : (
          <div className="scroll-thin overflow-x-auto">
            <table className="tbl">
              <thead>
                <tr>
                  <th>{t('escrows.id')}</th>
                  <th>{t('escrows.buyer')}</th>
                  <th>{t('escrows.seller')}</th>
                  <th className="text-end">{t('escrows.amount')}</th>
                  <th>{t('escrows.status')}</th>
                  <th>{t('escrows.created')}</th>
                  <th>{t('common.actions')}</th>
                </tr>
              </thead>
              <tbody>
                {escrows.map((esc) => (
                  <Fragment key={esc.id}>
                    <tr>
                      <td className="font-mono text-xs" dir="ltr" title={esc.id}>
                        {shortId(esc.id)}
                      </td>
                      <td className="font-mono text-xs" dir="ltr">
                        {shortId(esc.buyerId, 16)}
                      </td>
                      <td className="font-mono text-xs" dir="ltr">
                        {shortId(esc.sellerId, 16)}
                      </td>
                      <td className="text-end font-bold tabular-nums text-emerald-300">{din(esc.amount, lang)}</td>
                      <td>
                        <EscrowStatusBadge status={esc.status} />
                      </td>
                      <td className="text-xs text-ink-dim">{dateTime(esc.createdAt, lang)}</td>
                      <td>
                        <div className="flex flex-wrap gap-1.5">
                          {actionsFor(esc.status).map((a) => (
                            <Button
                              key={a}
                              variant={a === 'release' ? 'primary' : a === 'refund' || a === 'expire' ? 'danger' : 'ghost'}
                              loading={rowBusy === esc.id}
                              onClick={() => void runAction(esc, a)}
                            >
                              {t(ACTION_LABEL[a]!)}
                            </Button>
                          ))}
                          <Button variant="ghost" onClick={() => setExpanded(expanded === esc.id ? null : esc.id)}>
                            {t('escrows.detail')}
                          </Button>
                        </div>
                      </td>
                    </tr>
                    {expanded === esc.id && (
                      <tr>
                        <td colSpan={7} className="bg-white/[0.02]">
                          <div className="grid grid-cols-2 gap-x-6 gap-y-1.5 py-1 text-xs sm:grid-cols-4">
                            <span className="text-ink-dim">{t('escrows.tx')}: <span className="font-mono" dir="ltr">{esc.fundedTxId ?? '—'}</span></span>
                            <span className="text-ink-dim">{t('escrows.tx')} 2: <span className="font-mono" dir="ltr">{esc.settleTxId ?? '—'}</span></span>
                            <span className="text-ink-dim">{t('escrows.deliveryRef')}: <span className="font-mono" dir="ltr">{esc.deliveryRef ?? '—'}</span></span>
                            <span className="text-ink-dim">{t('escrows.productRef')}: <span className="font-mono" dir="ltr">{esc.productRef ?? '—'}</span></span>
                            <span className="text-ink-dim">{t('escrows.expires')}: {esc.expiresAt !== null ? dateTime(esc.expiresAt, lang) : '—'}</span>
                            <span className="col-span-2 text-ink-dim">
                              {t('escrows.disputeReason')}: {esc.disputeReason ?? '—'}
                            </span>
                          </div>
                          {(esc.status === 'FUNDED' || esc.status === 'DELIVERED' || esc.status === 'DISPUTED') && (
                            <div className="mt-2 max-w-sm">
                              <Field label={t('escrows.disputeReason')}>
                                <input className="inp" value={disputeReason} onChange={(e) => setDisputeReason(e.target.value)} />
                              </Field>
                            </div>
                          )}
                        </td>
                      </tr>
                    )}
                    {rowError?.id === esc.id && (
                      <tr>
                        <td colSpan={7}>
                          <ErrorBanner error={rowError.error} />
                        </td>
                      </tr>
                    )}
                  </Fragment>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}
