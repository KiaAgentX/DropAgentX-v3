/**
 * Settings — admin session management (key in sessionStorage only),
 * health info, contract links, and the immutable charter values.
 */

import { useState } from 'react';
import { useSession } from '../lib/session.js';
import { Banner, Button, Card, Field } from '../components/ui.js';

export function SettingsPage(): React.JSX.Element {
  const { t, lang, setLang, adminKey, setAdminKey, client } = useSession();
  const [keyInput, setKeyInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<'ok' | 'bad' | null>(null);

  const saveKey = async (): Promise<void> => {
    const trimmed = keyInput.trim();
    if (trimmed.length < 8) {
      setMsg('bad');
      return;
    }
    setBusy(true);
    const probe = await client.listAccounts();
    setBusy(false);
    if (probe.ok) {
      setAdminKey(trimmed);
      setMsg('ok');
      setKeyInput('');
      return;
    }
    setMsg('bad');
  };

  return (
    <div className="flex flex-col gap-5">
      <div>
        <h2 className="text-lg font-bold">{t('settings.title')}</h2>
        <p className="mt-0.5 text-xs text-ink-dim">{t('settings.subtitle')}</p>
      </div>

      <Card title={t('settings.session')}>
        <div className="mb-3 flex items-center justify-between gap-3">
          <div>
            <p className="text-xs text-ink-dim">{t('settings.keyState')}</p>
            <p className="mt-1 text-sm font-medium">
              {adminKey !== null ? (
                <span className="text-emerald-300">
                  {t('settings.keySet')} · <span className="font-mono">{'•'.repeat(8)}</span>
                </span>
              ) : (
                <span className="text-ink-dim">{t('settings.keyUnset')}</span>
              )}
            </p>
          </div>
          {adminKey !== null && (
            <Button
              variant="danger"
              onClick={() => {
                setAdminKey(null);
                setMsg(null);
              }}
            >
              {t('settings.clearKey')}
            </Button>
          )}
        </div>
        <form
          className="flex flex-col gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            void saveKey();
          }}
        >
          <Field label={t('gate.keyLabel')}>
            <input
              className="inp font-mono"
              dir="ltr"
              type="password"
              value={keyInput}
              onChange={(e) => setKeyInput(e.target.value)}
              placeholder={t('gate.keyPlaceholder')}
              autoComplete="off"
            />
          </Field>
          {msg === 'ok' && <Banner tone="mint">{t('settings.keySet')}</Banner>}
          {msg === 'bad' && <Banner tone="red">{t('gate.wrongKey')}</Banner>}
          <div className="flex gap-2">
            <Button type="submit" variant="primary" loading={busy}>
              {t('settings.changeKey')}
            </Button>
          </div>
          <p className="text-[11px] leading-relaxed text-ink-dim">{t('settings.securityNote')}</p>
        </form>
      </Card>

      <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
        <Card title={t('settings.lang')}>
          <div className="flex gap-2">
            <Button variant={lang === 'fa' ? 'primary' : 'ghost'} onClick={() => setLang('fa')}>
              فارسی (RTL)
            </Button>
            <Button variant={lang === 'en' ? 'primary' : 'ghost'} onClick={() => setLang('en')}>
              English (LTR)
            </Button>
          </div>
        </Card>

        <Card title={t('settings.api')}>
          <div className="flex flex-col gap-2 text-sm">
            <a className="text-cyan-300 hover:underline" href="/api/v1/openapi.json" target="_blank" rel="noreferrer">
              {t('settings.openapi')} ↗
            </a>
            <a className="text-cyan-300 hover:underline" href="/api/v1/docs" target="_blank" rel="noreferrer">
              {t('settings.docs')} ↗
            </a>
            <p className="font-mono text-xs text-ink-dim" dir="ltr">
              GET /api/v1/economy · health · accounts · escrows · hitl
            </p>
          </div>
        </Card>
      </div>

      <Card title={t('settings.charter')}>
        <ul className="grid grid-cols-1 gap-2 text-sm sm:grid-cols-2">
          <li className="flex items-center gap-2"><Badge_ />{t('settings.charterTax')}</li>
          <li className="flex items-center gap-2"><Badge_ />{t('settings.charterHitl')}</li>
          <li className="flex items-center gap-2"><Badge_ />{t('settings.charterCap')}</li>
          <li className="flex items-center gap-2"><Badge_ />{t('settings.charterGenesis')}</li>
        </ul>
      </Card>
    </div>
  );
}

function Badge_(): React.JSX.Element {
  return <span aria-hidden className="text-emerald-300">§</span>;
}
