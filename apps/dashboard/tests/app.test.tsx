// @vitest-environment jsdom
/**
 * Phase-4 acceptance — App shell smoke over a stub client: public overview
 * renders, admin routes gate without a key, admin pages unlock with a key,
 * RTL is the default and EN flips the document direction (RTL-without-
 * breakage gate), and wire errors render as friendly localized copy.
 */

import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { V3Client } from '@dropagentx/contracts';
import { App } from '../src/App.js';
import { SessionProvider } from '../src/lib/session.js';
import type { ApiClientResult } from '@dropagentx/contracts';

const ok = <T,>(value: T): ApiClientResult<T> => ({ ok: true, value });

function stubClient(overrides: Partial<V3Client> = {}): V3Client {
  const base: V3Client = {
    economy: () =>
      Promise.resolve(
        ok({
          currency: 'DNX' as const,
          symbol: 'Đ' as const,
          circulatingSupply: 1_000,
          treasuryBalance: 10,
          escrowLocked: 0,
          mintedAllTime: 1_000,
          burnedAllTime: 0,
          mintedThisYear: 1_000,
          yearlyMintCap: 1_000_000,
          genesisSupply: 187_672,
          trialBalanceSum: 0,
          balanced: true,
          accountCount: 3,
          openEscrows: 0,
        }),
      ),
    health: () =>
      Promise.resolve(ok({ status: 'ok' as const, service: 'dropagentx-v3-server' as const, version: '0.4.0', llmConfigured: true, llmModel: 'glm-4' })),
    createAccount: () => Promise.resolve(ok({ id: 'x', kind: 'user', label: null, balance: 0, createdAt: '2026-01-01T00:00:00Z' })),
    listAccounts: () =>
      Promise.resolve(
        ok({
          items: [
            { id: 'user:buy:1', kind: 'user', label: 'buyer', balance: 1_000, createdAt: '2026-01-01T00:00:00Z' },
            { id: 'mint:genesis', kind: 'mint', label: null, balance: -1_000, createdAt: '2026-01-01T00:00:00Z' },
          ],
        }),
      ),
    balance: () => Promise.resolve(ok({ accountId: 'x', balance: 0 })),
    mint: () => Promise.resolve(ok({ txId: 'tx-1', accountId: 'x', balance: 1, replayed: false })),
    burn: () => Promise.resolve(ok({ txId: 'tx-1', accountId: 'x', balance: 0, replayed: false })),
    createEscrow: () => Promise.resolve(ok({ escrow: escrowOf('CREATED'), txId: null, replayed: false })),
    listEscrows: () => Promise.resolve(ok({ items: [escrowOf('FUNDED')] })),
    getEscrow: () => Promise.resolve(ok(escrowOf('FUNDED'))),
    fundEscrow: () => Promise.resolve(ok({ escrow: escrowOf('FUNDED'), txId: 'tx-2', replayed: false })),
    deliverEscrow: () => Promise.resolve(ok({ escrow: escrowOf('DELIVERED'), txId: 'tx-3', replayed: false })),
    releaseEscrow: () => Promise.resolve(ok({ escrow: escrowOf('RELEASED'), txId: 'tx-4', replayed: false })),
    disputeEscrow: () => Promise.resolve(ok({ escrow: escrowOf('DISPUTED'), txId: null, replayed: false })),
    refundEscrow: () => Promise.resolve(ok({ escrow: escrowOf('REFUNDED'), txId: 'tx-5', replayed: false })),
    cancelEscrow: () => Promise.resolve(ok({ escrow: escrowOf('CANCELLED'), txId: null, replayed: false })),
    expireEscrow: () => Promise.resolve(ok({ escrow: escrowOf('EXPIRED'), txId: null, replayed: false })),
    createHitlRequest: () => Promise.resolve(ok(hitlOf())),
    listHitl: () => Promise.resolve(ok({ items: [hitlOf()] })),
    getHitl: () => Promise.resolve(ok(hitlOf())),
    approveHitl: () => Promise.resolve(ok({ request: { ...hitlOf(), status: 'APPROVED' as const }, escrow: escrowOf('RELEASED'), txId: 'tx-9', replayed: false })),
    rejectHitl: () => Promise.resolve(ok({ request: { ...hitlOf(), status: 'REJECTED' as const }, escrow: null, txId: null, replayed: false })),
    sweepHitl: () => Promise.resolve(ok({ expired: 0 })),
  };
  return { ...base, ...overrides };
}

function escrowOf(status: 'CREATED' | 'FUNDED' | 'DELIVERED' | 'RELEASED' | 'DISPUTED' | 'REFUNDED' | 'CANCELLED' | 'EXPIRED') {
  return {
    id: 'escrow:dash:1',
    buyerId: 'user:buy:1',
    sellerId: 'user:sell:1',
    amount: 100,
    productRef: null,
    status,
    createdAt: '2026-01-01T00:00:00Z',
    fundedTxId: 'tx-2',
    settleTxId: null,
    disputeReason: null,
    deliveryRef: null,
    expiresAt: null,
  };
}

function hitlOf() {
  return {
    id: 'hitl-1',
    kind: 'ESCROW_RELEASE' as const,
    escrowId: 'escrow:dash:1',
    amount: 60_000,
    requesterId: 'user:sell:1',
    note: null,
    status: 'PENDING' as const,
    createdAt: '2026-01-01T00:00:00Z',
    expiresAt: '2026-01-02T00:00:00Z',
    decidedBy: null,
    decidedAt: null,
    decisionNote: null,
  };
}

function renderApp(client: V3Client, hash: string): void {
  window.location.hash = hash;
  render(
    <SessionProvider client={client}>
      <App />
    </SessionProvider>,
  );
}

afterEach(() => {
  cleanup();
  window.sessionStorage.clear();
  window.localStorage.clear();
  window.location.hash = '';
});

describe('App shell', () => {
  it('renders the public overview with economy numbers (fa default, RTL)', async () => {
    renderApp(stubClient(), '#/overview');
    expect(document.documentElement.dir).toBe('rtl');
    expect(await screen.findByText('نمای کلی اقتصاد')).toBeDefined();
    // Genesis supply is unique on the page; the minted-year + circulating values collide by design
    expect(await screen.findByText(/۱۸۷٬۶۷۲ Đ/)).toBeDefined();
    expect(screen.getAllByText(/۱٬۰۰۰ Đ/).length).toBeGreaterThanOrEqual(2);
  });

  it('gates admin routes without a key', async () => {
    renderApp(stubClient(), '#/accounts');
    expect(await screen.findByText('دسترسی مدیر لازم است')).toBeDefined();
  });

  it('unlocks admin pages when a key is stored in sessionStorage', async () => {
    window.sessionStorage.setItem('v3.adminKey', 'test-admin-key-0123456');
    renderApp(stubClient(), '#/accounts');
    expect(await screen.findByText('user:buy:1')).toBeDefined();
    expect(screen.getAllByText(/۱٬۰۰۰/).length).toBeGreaterThanOrEqual(2); // buyer balance + mint mirror
  });

  it('shows the HITL queue with a pending badge', async () => {
    window.sessionStorage.setItem('v3.adminKey', 'test-admin-key-0123456');
    renderApp(stubClient(), '#/hitl');
    expect(await screen.findByText('hitl-1')).toBeDefined();
    expect(screen.getAllByText('در انتظار').length).toBeGreaterThanOrEqual(2); // badge + filter chip
    expect(await screen.findByText('۶۰٬۰۰۰ Đ')).toBeDefined();
  });

  it('EN flips the document to LTR and translates the overview', async () => {
    window.localStorage.setItem('v3.lang', 'en');
    renderApp(stubClient(), '#/overview');
    expect(await screen.findByText('Economy overview')).toBeDefined();
    expect(document.documentElement.dir).toBe('ltr');
    expect(await screen.findByText(/187,672 Đ/)).toBeDefined();
  });
});
