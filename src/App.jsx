import { useState, useEffect } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { open } from '@tauri-apps/plugin-dialog';
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

function AddEnvironmentDialog({ onSave, onCancel }) {
  const [name, setName] = useState('');
  const [folder, setFolder] = useState('');
  const [error, setError] = useState(null);
  const [saving, setSaving] = useState(false);

  async function browseFolder() {
    const selected = await open({ directory: true, title: 'Select UE4SS Mods Folder' });
    if (selected) setFolder(selected);
  }

  async function handleSave() {
    if (!name.trim()) { setError('Enter a name for this environment.'); return; }
    if (!folder.trim()) { setError('Select a mods folder.'); return; }
    setSaving(true);
    try {
      const env = await invoke('add_environment', { name: name.trim(), modsFolder: folder.trim() });
      onSave(env);
    } catch (e) {
      setError(String(e));
      setSaving(false);
    }
  }

  return (
    <div className="modal-overlay">
      <div className="modal-box">
        <h3 style={{marginBottom:'16px'}}>Add Environment</h3>
        <label className="settings-hint" style={{display:'block', marginBottom:'4px'}}>Name</label>
        <input
          className="input"
          placeholder="e.g. Test Install"
          value={name}
          onChange={e => setName(e.target.value)}
          autoFocus
          style={{width:'100%', marginBottom:'12px'}}
        />
        <label className="settings-hint" style={{display:'block', marginBottom:'4px'}}>UE4SS Mods Folder</label>
        <div className="input-row" style={{marginBottom:'16px'}}>
          <input className="input mono" value={folder} onChange={e => setFolder(e.target.value)} spellCheck={false} />
          <button className="btn-ghost" onClick={browseFolder}>Browse</button>
        </div>
        {error && <p style={{color:'var(--error)', fontSize:'12px', marginBottom:'12px'}}>{error}</p>}
        <div style={{display:'flex', gap:'8px', justifyContent:'flex-end'}}>
          <button className="btn-ghost sm" onClick={onCancel}>Cancel</button>
          <button className="btn-primary sm" onClick={handleSave} disabled={saving}>
            {saving ? 'Adding…' : 'Add'}
          </button>
        </div>
      </div>
    </div>
  );
}

export default function App() {
  const [config, setConfig] = useState(null);
  const [ready, setReady] = useState(false);
  const [tab, setTab] = useState('discover');
  const [nxmNotif, setNxmNotif] = useState(null);
  const [updateInfo, setUpdateInfo] = useState(null);
  const [isPremium, setIsPremium] = useState(false);
  const [environments, setEnvironments] = useState([]);
  const [activeEnvId, setActiveEnvId] = useState(null);
  const [showAddEnv, setShowAddEnv] = useState(false);

  useEffect(() => {
    invoke('get_config')
      .then(cfg => {
        setConfig(cfg);
        setReady(true);
        if (cfg?.environments) setEnvironments(cfg.environments);
        if (cfg?.activeEnvironmentId) setActiveEnvId(cfg.activeEnvironmentId);
        invoke('check_for_update').then(info => setUpdateInfo(info)).catch(() => {});
        invoke('nexus_get_auth_status').then(status => setIsPremium(status.isPremium)).catch(() => {});
      })
      .catch(() => setReady(true));
  }, []);

  function handleConfigChange(cfg) {
    setConfig(cfg);
  }

  async function recheckUpdate() {
    setUpdateInfo(null);
    const info = await invoke('check_for_update').catch(() => null);
    setUpdateInfo(info);
  }

  async function handleSwitchEnv(id) {
    try {
      const cfg = await invoke('switch_environment', { id });
      setConfig(cfg);
      setActiveEnvId(id);
    } catch (e) {
      alert(`Failed to switch environment: ${e}`);
    }
  }

  async function handleRemoveEnv(id) {
    if (!confirm('Remove this environment? This does not delete any game files.')) return;
    try {
      await invoke('remove_environment', { id });
      setEnvironments(prev => prev.filter(e => e.id !== id));
    } catch (e) {
      alert(String(e));
    }
  }

  function handleEnvAdded(env) {
    setEnvironments(prev => [...prev, env]);
    setShowAddEnv(false);
  }

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
      <TitleBar
        environments={environments}
        activeEnvId={activeEnvId}
        onSwitch={handleSwitchEnv}
        onAddEnvironment={() => setShowAddEnv(true)}
        onRemoveEnvironment={handleRemoveEnv}
      />
      <NxmBanner notif={nxmNotif} onDismiss={() => setNxmNotif(null)} />
      {showAddEnv && (
        <AddEnvironmentDialog
          onSave={handleEnvAdded}
          onCancel={() => setShowAddEnv(false)}
        />
      )}
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
