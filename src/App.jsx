import { useState, useEffect, useRef } from 'react';
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

function SteamInstallDialog({ onDone, onCancel }) {
  const [step, setStep] = useState('setup');
  // step: 'setup' | 'installing-depot' | 'running' | 'needs-password' | 'needs-steam-guard' | 'done' | 'error'
  const [username, setUsername] = useState('');
  const [installPath, setInstallPath] = useState('');
  const [log, setLog] = useState([]);
  const [inputVal, setInputVal] = useState('');
  const [envName, setEnvName] = useState('Test Install');
  const [errorMsg, setErrorMsg] = useState('');
  const [hasDepot, setHasDepot] = useState(null);
  const logRef = useRef(null);

  useEffect(() => {
    invoke('check_depot_downloader').then(setHasDepot);
  }, []);

  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [log]);

  useEffect(() => {
    const unlisteners = [];
    const addLine = line => setLog(prev => [...prev, line]);

    listen('depot-progress', e => addLine(e.payload)).then(fn => unlisteners.push(fn));
    listen('depot-needs-password', e => {
      addLine(e.payload);
      setStep('needs-password');
      setInputVal('');
    }).then(fn => unlisteners.push(fn));
    listen('depot-needs-steam-guard', e => {
      addLine(e.payload);
      setStep('needs-steam-guard');
      setInputVal('');
    }).then(fn => unlisteners.push(fn));
    listen('depot-complete', () => setStep('done')).then(fn => unlisteners.push(fn));
    listen('depot-error', e => {
      setErrorMsg(e.payload);
      setStep('error');
    }).then(fn => unlisteners.push(fn));

    return () => unlisteners.forEach(fn => fn?.());
  }, []);

  async function installDepot() {
    setStep('installing-depot');
    try {
      await invoke('install_depot_downloader');
      setHasDepot(true);
      setStep('setup');
    } catch (e) {
      setErrorMsg(String(e));
      setStep('error');
    }
  }

  async function startDownload() {
    setStep('running');
    setLog([]);
    try {
      await invoke('steam_install_sn2', { username: username.trim(), installPath: installPath.trim() });
    } catch (e) {
      setErrorMsg(String(e));
      setStep('error');
    }
  }

  async function sendInput() {
    const val = inputVal.trim();
    if (!val) return;
    try {
      await invoke('depot_send_input', { text: val });
      setLog(prev => [...prev, `> ${val}`]);
      setInputVal('');
      setStep('running');
    } catch (e) {
      setErrorMsg(String(e));
    }
  }

  async function handleCancel() {
    await invoke('depot_cancel').catch(() => {});
    onCancel();
  }

  async function handleDone() {
    if (!envName.trim()) return;
    try {
      const modsFolder = await invoke('create_mod_structure', { gameFolder: installPath.trim() });
      const env = await invoke('add_environment', { name: envName.trim(), modsFolder });
      onDone(env);
    } catch (e) {
      setErrorMsg(String(e));
    }
  }

  async function browseInstallPath() {
    const selected = await open({ directory: true, title: 'Choose installation folder' });
    if (selected) setInstallPath(selected);
  }

  return (
    <div className="modal-overlay">
      <div className="modal-box" style={{ width: '500px', maxWidth: '90vw' }}>
        <h3 style={{ marginBottom: '16px' }}>Download via Steam</h3>

        {step === 'setup' && (
          <>
            {hasDepot === false && (
              <div style={{ background: 'var(--bg2)', borderRadius: '6px', padding: '12px', marginBottom: '16px' }}>
                <p style={{ fontSize: '13px', marginBottom: '10px' }}>
                  Tidekeeper needs a small helper tool to download from Steam. It will be downloaded automatically.
                </p>
                <button className="btn-primary sm" onClick={installDepot}>Download helper tool</button>
              </div>
            )}
            <label className="settings-hint" style={{ display: 'block', marginBottom: '4px' }}>Steam Username</label>
            <input
              className="input"
              placeholder="Your Steam account name"
              value={username}
              onChange={e => setUsername(e.target.value)}
              autoFocus
              style={{ width: '100%', marginBottom: '12px' }}
            />
            <label className="settings-hint" style={{ display: 'block', marginBottom: '4px' }}>Install Folder</label>
            <div className="input-row" style={{ marginBottom: '6px' }}>
              <input className="input mono" value={installPath} onChange={e => setInstallPath(e.target.value)} spellCheck={false} />
              <button className="btn-ghost" onClick={browseInstallPath}>Browse</button>
            </div>
            <p className="settings-hint" style={{ marginBottom: '16px' }}>
              A fresh copy of Subnautica 2 will be downloaded here. You must own the game on Steam.
            </p>
            <div style={{ display: 'flex', gap: '8px', justifyContent: 'flex-end' }}>
              <button className="btn-ghost sm" onClick={handleCancel}>Cancel</button>
              <button
                className="btn-primary sm"
                onClick={startDownload}
                disabled={!username.trim() || !installPath.trim() || hasDepot === false}
              >
                Start Download
              </button>
            </div>
          </>
        )}

        {step === 'installing-depot' && (
          <div style={{ textAlign: 'center', padding: '24px 0' }}>
            <div className="nxm-spinner" style={{ margin: '0 auto 12px' }} />
            <p>Downloading helper tool…</p>
          </div>
        )}

        {(step === 'running' || step === 'needs-password' || step === 'needs-steam-guard') && (
          <>
            <div
              ref={logRef}
              style={{
                background: 'var(--bg2)', borderRadius: '6px', padding: '10px',
                height: '200px', overflowY: 'auto', fontFamily: 'monospace',
                fontSize: '11px', marginBottom: '12px', whiteSpace: 'pre-wrap',
                wordBreak: 'break-all',
              }}
            >
              {log.map((l, i) => <div key={i}>{l}</div>)}
              {step === 'running' && <div style={{ opacity: 0.4 }}>Downloading…</div>}
            </div>

            {step === 'needs-password' && (
              <div style={{ marginBottom: '12px' }}>
                <label className="settings-hint" style={{ display: 'block', marginBottom: '4px' }}>Steam Password</label>
                <div className="input-row">
                  <input
                    type="password"
                    className="input"
                    value={inputVal}
                    onChange={e => setInputVal(e.target.value)}
                    onKeyDown={e => e.key === 'Enter' && sendInput()}
                    autoFocus
                  />
                  <button className="btn-primary sm" onClick={sendInput}>Send</button>
                </div>
              </div>
            )}

            {step === 'needs-steam-guard' && (
              <div style={{ marginBottom: '12px' }}>
                <label className="settings-hint" style={{ display: 'block', marginBottom: '4px' }}>Steam Guard Code</label>
                <div className="input-row">
                  <input
                    className="input mono"
                    placeholder="e.g. AB1CD"
                    value={inputVal}
                    onChange={e => setInputVal(e.target.value.toUpperCase())}
                    onKeyDown={e => e.key === 'Enter' && sendInput()}
                    autoFocus
                    maxLength={8}
                  />
                  <button className="btn-primary sm" onClick={sendInput}>Send</button>
                </div>
              </div>
            )}

            {step === 'running' && (
              <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
                <button className="btn-ghost sm" onClick={handleCancel}>Cancel</button>
              </div>
            )}
          </>
        )}

        {step === 'done' && (
          <>
            <p style={{ color: 'var(--accent)', marginBottom: '16px' }}>
              Download complete! Give this install a name to add it as an environment.
            </p>
            <label className="settings-hint" style={{ display: 'block', marginBottom: '4px' }}>Environment Name</label>
            <input
              className="input"
              placeholder="e.g. Test Install"
              value={envName}
              onChange={e => setEnvName(e.target.value)}
              autoFocus
              style={{ width: '100%', marginBottom: '16px' }}
            />
            <div style={{ display: 'flex', gap: '8px', justifyContent: 'flex-end' }}>
              <button className="btn-ghost sm" onClick={handleCancel}>Cancel</button>
              <button className="btn-primary sm" onClick={handleDone} disabled={!envName.trim()}>
                Add to Tidekeeper
              </button>
            </div>
          </>
        )}

        {step === 'error' && (
          <>
            <p style={{ color: 'var(--error)', marginBottom: '16px', fontSize: '13px' }}>
              {errorMsg || 'Something went wrong.'}
            </p>
            <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
              <button className="btn-ghost sm" onClick={handleCancel}>Close</button>
            </div>
          </>
        )}
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
  const [showSteamInstall, setShowSteamInstall] = useState(false);

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
        onSteamInstall={() => setShowSteamInstall(true)}
      />
      <NxmBanner notif={nxmNotif} onDismiss={() => setNxmNotif(null)} />
      {showAddEnv && (
        <AddEnvironmentDialog
          onSave={handleEnvAdded}
          onCancel={() => setShowAddEnv(false)}
        />
      )}
      {showSteamInstall && (
        <SteamInstallDialog
          onDone={env => { setEnvironments(prev => [...prev, env]); setShowSteamInstall(false); }}
          onCancel={() => setShowSteamInstall(false)}
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
