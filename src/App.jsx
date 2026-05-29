import { useState, useEffect } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import TitleBar from './components/TitleBar';
import Sidebar from './components/Sidebar';
import SetupView from './views/SetupView';
import DiscoverView from './views/DiscoverView';
import LibraryView from './views/LibraryView';
import SettingsView from './views/SettingsView';
import UpdatesView from './views/UpdatesView';

function NxmBanner({ notif, onDismiss }) {
  if (!notif) return null;
  const isError = notif.type === 'error';
  const isLoading = notif.type === 'started';
  return (
    <div className="nxm-banner" style={{ background: isError ? 'var(--error)' : 'var(--accent)' }}>
      {isLoading && <div className="nxm-spinner" />}
      <span>{notif.text}</span>
      {!isLoading && <button className="nxm-dismiss" onClick={onDismiss}>✕</button>}
    </div>
  );
}

export default function App() {
  const [config, setConfig] = useState(null);
  const [ready, setReady] = useState(false);
  const [tab, setTab] = useState('discover');
  const [nxmNotif, setNxmNotif] = useState(null);
  const [updateInfo, setUpdateInfo] = useState(null); // null | { available, version, notes }
  const [isPremium, setIsPremium] = useState(false);

  useEffect(() => {
    invoke('get_config')
      .then(cfg => {
        setConfig(cfg);
        setReady(true);
        invoke('check_for_update').then(info => setUpdateInfo(info)).catch(() => {});
        if (cfg?.nexusApiKey) {
          invoke('validate_nexus_key').then(info => setIsPremium(info.isPremium)).catch(() => {});
        }
      })
      .catch(() => setReady(true));
  }, []);

  function handleConfigChange(cfg) {
    setConfig(cfg);
    if (cfg?.nexusApiKey) {
      invoke('validate_nexus_key').then(info => setIsPremium(info.isPremium)).catch(() => {});
    }
  }

  async function recheckUpdate() {
    setUpdateInfo(null);
    const info = await invoke('check_for_update').catch(() => null);
    setUpdateInfo(info);
  }

  // Listen for NXM download events from Rust
  useEffect(() => {
    let unlistenStarted, unlistenDone, unlistenError;

    listen('nxm-started', e => {
      setNxmNotif({ type: 'started', text: `Downloading ${e.payload}…` });
    }).then(fn => { unlistenStarted = fn; });

    listen('nxm-installed', e => {
      setNxmNotif({ type: 'installed', text: `Installed: ${e.payload}` });
      setTimeout(() => setNxmNotif(null), 5000);
    }).then(fn => { unlistenDone = fn; });

    listen('nxm-error', e => {
      setNxmNotif({ type: 'error', text: `Install failed: ${e.payload}` });
    }).then(fn => { unlistenError = fn; });

    // Handle NXM link if app was launched by clicking one
    invoke('get_pending_nxm').then(url => {
      if (url) invoke('handle_nxm', { nxmUrl: url }).catch(e => {
        setNxmNotif({ type: 'error', text: `Install failed: ${e}` });
      });
    });

    return () => {
      unlistenStarted?.();
      unlistenDone?.();
      unlistenError?.();
    };
  }, []);

  if (!ready) return null;

  const needsSetup = !config?.setupComplete;

  return (
    <div className="app">
      <TitleBar />
      <NxmBanner notif={nxmNotif} onDismiss={() => setNxmNotif(null)} />
      <div className="app-body">
        {needsSetup ? (
          <SetupView onComplete={cfg => { setConfig(cfg); setTab('library'); }} />
        ) : (
          <>
            <Sidebar activeTab={tab} onTabChange={setTab} hasUpdate={updateInfo?.available ?? false} />
            <main className="content-area">
              {tab === 'discover'  && <DiscoverView config={config} onTabChange={setTab} isPremium={isPremium} />}
              {tab === 'library'   && <LibraryView config={config} onConfigChange={setConfig} />}
              {tab === 'updates'   && <UpdatesView config={config} onTabChange={setTab} />}
              {tab === 'settings'  && <SettingsView config={config} onConfigChange={handleConfigChange} updateInfo={updateInfo} onRecheckUpdate={recheckUpdate} />}
            </main>
          </>
        )}
      </div>
    </div>
  );
}
