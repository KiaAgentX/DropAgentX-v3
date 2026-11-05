/**
 * App — hash routing + the admin gate. Public routes render freely;
 * admin routes redirect to the gate when no key is set. The gate
 * validates the key by actually calling an admin endpoint (fail-closed:
 * we never assume a key is good).
 */

import { useMemo, useState } from 'react';
import { useSession } from './lib/session.js';
import { useRoute, navigate, type RoutePath } from './lib/router.js';
import { createDashboardClient } from './lib/api.js';
import { Shell } from './components/Shell.js';
import { Banner, Button, Card, Field } from './components/ui.js';
import { OverviewPage } from './pages/OverviewPage.js';
import { AccountsPage } from './pages/AccountsPage.js';
import { EscrowsPage } from './pages/EscrowsPage.js';
import { HitlPage } from './pages/HitlPage.js';
import { SettingsPage } from './pages/SettingsPage.js';

const ADMIN_ROUTES: ReadonlySet<RoutePath> = new Set(['/accounts', '/escrows', '/hitl']);

function Gate(): React.JSX.Element {
  const { t, setAdminKey, baseUrl } = useSession();
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<'wrong' | 'server' | null>(null);

  const submit = async (): Promise<void> => {
    const trimmed = key.trim();
    if (trimmed.length < 8) {
      setError('wrong');
      return;
    }
    setBusy(true);
    setError(null);
    // Fail-closed: prove the entered key with a REAL admin call before
    // storing it — the probe client carries the key, the session client
    // doesn't have it yet by definition.
    const probe = createDashboardClient({ baseUrl, adminKey: trimmed });
    const res = await probe.listAccounts();
    setBusy(false);
    if (res.ok) {
      setAdminKey(trimmed);
      navigate('/accounts');
      return;
    }
    setError(res.error.code === 'NETWORK' ? 'server' : 'wrong');
  };

  return (
    <Card title={t('gate.title')} subtitle={t('gate.hint')} className="mx-auto max-w-md">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
        className="flex flex-col gap-3"
      >
        <Field label={t('gate.keyLabel')}>
          <input
            className="inp font-mono"
            type="password"
            value={key}
            onChange={(e) => setKey(e.target.value)}
            placeholder={t('gate.keyPlaceholder')}
            autoComplete="off"
            dir="ltr"
          />
        </Field>
        {error !== null && <Banner tone="red">{error === 'server' ? t('gate.noServer') : t('gate.wrongKey')}</Banner>}
        <Button type="submit" variant="primary" loading={busy}>
          {t('gate.enter')}
        </Button>
      </form>
    </Card>
  );
}

export function App(): React.JSX.Element {
  const route = useRoute();
  const { adminKey } = useSession();

  const page = useMemo(() => {
    if (ADMIN_ROUTES.has(route) && adminKey === null) return <Gate />;
    switch (route) {
      case '/overview':
        return <OverviewPage />;
      case '/accounts':
        return <AccountsPage />;
      case '/escrows':
        return <EscrowsPage />;
      case '/hitl':
        return <HitlPage />;
      case '/settings':
        return <SettingsPage />;
    }
  }, [route, adminKey]);

  return <Shell>{page}</Shell>;
}
