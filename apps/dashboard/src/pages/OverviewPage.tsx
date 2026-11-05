/**
 * Overview — the public transparency page (charter Article 6).
 * Economy summary + server health; works with no admin key.
 */

import { useSession } from '../lib/session.js';
import { unwrap } from '../lib/api.js';
import { din, num, pct } from '../lib/format.js';
import { Banner, Button, Card, ErrorBanner, Stat, useLoad } from '../components/ui.js';

interface OverviewData {
  readonly circulatingSupply: number;
  readonly treasuryBalance: number;
  readonly escrowLocked: number;
  readonly mintedAllTime: number;
  readonly burnedAllTime: number;
  readonly mintedThisYear: number;
  readonly yearlyMintCap: number;
  readonly genesisSupply: number;
  readonly trialBalanceSum: number;
  readonly balanced: boolean;
  readonly accountCount: number;
  readonly openEscrows: number;
  readonly status: string;
  readonly version: string;
  readonly llmConfigured: boolean;
  readonly llmModel: string | null;
}

async function loadOverview(client: ReturnType<typeof useSession>['client']): Promise<OverviewData> {
  const [economy, health] = await Promise.all([unwrap(client.economy()), unwrap(client.health())]);
  return {
    ...economy,
    status: health.status,
    version: health.version,
    llmConfigured: health.llmConfigured,
    llmModel: health.llmModel,
  };
}

export function OverviewPage(): React.JSX.Element {
  const { t, lang, client } = useSession();
  const { data, error, loading, refresh } = useLoad(() => loadOverview(client), [client]);

  if (error !== null) return <ErrorBanner error={error} extra={t('gate.noServer')} />;
  if (data === null) return <p className="text-sm text-ink-dim">{t('common.loading')}</p>;

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-bold">{t('overview.title')}</h2>
          <p className="mt-0.5 text-xs text-ink-dim">{t('overview.subtitle')}</p>
        </div>
        <Button onClick={refresh} loading={loading}>
          {t('common.refresh')}
        </Button>
      </div>

      {!data.balanced && <Banner tone="red">{t('overview.unbalanced')}</Banner>}

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        <Stat label={t('overview.circulating')} value={din(data.circulatingSupply, lang)} tone="mint" />
        <Stat label={t('overview.treasury')} value={din(data.treasuryBalance, lang)} tone="cyan" />
        <Stat label={t('overview.escrowLocked')} value={din(data.escrowLocked, lang)} tone="violet" />
        <Stat
          label={t('overview.mintedYear')}
          value={din(data.mintedThisYear, lang)}
          hint={t('overview.capUsage', { pct: pct(data.mintedThisYear, data.yearlyMintCap, lang) })}
          tone="amber"
        />
        <Stat label={t('overview.burned')} value={din(data.burnedAllTime, lang)} tone="red" />
        <Stat label={t('overview.genesis')} value={din(data.genesisSupply, lang)} />
        <Stat label={t('overview.accounts')} value={num(data.accountCount, lang)} />
        <Stat label={t('overview.openEscrows')} value={num(data.openEscrows, lang)} />
        <Stat label={t('overview.trialSum')} value={num(data.trialBalanceSum, lang)} />
      </div>

      {/* Yearly mint cap gauge */}
      <Card title={t('overview.mintCap')}>
        <div className="h-2.5 w-full overflow-hidden rounded-full bg-white/10">
          <div
            className="h-full rounded-full bg-gradient-to-r from-amber-300 to-red-300"
            style={{ width: `${Math.min(100, (data.mintedThisYear / data.yearlyMintCap) * 100).toFixed(2)}%` }}
          />
        </div>
        <p className="mt-2 text-xs text-ink-dim">
          {din(data.mintedThisYear, lang)} / {din(data.yearlyMintCap, lang)} (
          {pct(data.mintedThisYear, data.yearlyMintCap, lang)})
        </p>
      </Card>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Card title={t('overview.health')}>
          <dl className="flex flex-col gap-2 text-sm">
            <div className="flex justify-between gap-2">
              <dt className="text-ink-dim">{t('overview.status')}</dt>
              <dd className="font-medium text-emerald-300">{data.status}</dd>
            </div>
            <div className="flex justify-between gap-2">
              <dt className="text-ink-dim">{t('overview.version')}</dt>
              <dd className="font-mono text-xs">{data.version}</dd>
            </div>
            <div className="flex justify-between gap-2">
              <dt className="text-ink-dim">{t('overview.balanced')}</dt>
              <dd className={data.balanced ? 'text-emerald-300' : 'text-red-300'}>{data.balanced ? '✓' : '✗'}</dd>
            </div>
          </dl>
        </Card>
        <Card title={t('overview.aiCycle')}>
          <p className="text-sm">{data.llmConfigured ? t('overview.aiEnabled', { model: data.llmModel ?? '—' }) : t('overview.aiDisabled')}</p>
          <p className="mt-2 text-xs text-ink-dim">OPENAI_BASE_URL · OPENAI_API_KEY · MODEL</p>
        </Card>
      </div>
    </div>
  );
}
