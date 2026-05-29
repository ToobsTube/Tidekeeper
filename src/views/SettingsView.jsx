import { useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { open } from '@tauri-apps/plugin-dialog';
import { openUrl } from '@tauri-apps/plugin-opener';
import { getVersion } from '@tauri-apps/api/app';
import { PRESETS, saveTheme } from '../utils/theme';

export default function SettingsView({ config, onConfigChange, updateInfo, onRecheckUpdate }) {
  const [folder, setFolder]           = useState(config?.modsFolder ?? '');
  const [apiKey, setApiKey]           = useState(config?.nexusApiKey ?? '');
  const [downloadDir, setDownloadDir] = useState(config?.downloadDir ?? '');
  const [folderMsg, setFolderMsg]     = useState(null);
  const [keyMsg, setKeyMsg]           = useState(null);
  const [dlMsg, setDlMsg]             = useState(null);
  const [appVersion, setAppVersion]   = useState('');
  const [installing, setInstalling]   = useState(false);
  const [accent, setAccent]           = useState(() => localStorage.getItem('tk-accent') ?? '#00d4ff');

  useState(() => { getVersion().then(v => setAppVersion(v)).catch(() => {}); });

  function pickTheme(color) {
    setAccent(color);
    saveTheme(color);
  }

  async function doInstallUpdate() {
    setInstalling(true);
    try {
      await invoke('install_update');
    } catch (e) {
      alert(`Update failed: ${e}`);
      setInstalling(false);
    }
  }

  async function browseFolder() {
    const selected = await open({ directory: true, title: 'Select UE4SS Mods Folder' });
    if (selected) setFolder(selected);
  }

  async function browseDownloadDir() {
    const selected = await open({ directory: true, title: 'Select Download Directory' });
    if (selected) setDownloadDir(selected);
  }

  async function saveFolder() {
    setFolderMsg(null);
    const valid = await invoke('validate_folder', { path: folder.trim() });
    if (!valid) { setFolderMsg({ ok: false, text: 'Folder not found.' }); return; }
    const updated = { ...config, modsFolder: folder.trim() };
    await invoke('save_config', { config: updated });
    onConfigChange(updated);
    setFolderMsg({ ok: true, text: 'Saved.' });
    setTimeout(() => setFolderMsg(null), 2000);
  }

  async function saveDownloadDir() {
    setDlMsg(null);
    const path = downloadDir.trim();
    if (path) {
      const valid = await invoke('validate_folder', { path });
      if (!valid) { setDlMsg({ ok: false, text: 'Folder not found.' }); return; }
    }
    const updated = { ...config, downloadDir: path || null };
    await invoke('save_config', { config: updated });
    onConfigChange(updated);
    setDlMsg({ ok: true, text: 'Saved.' });
    setTimeout(() => setDlMsg(null), 2000);
  }

  async function saveApiKey() {
    setKeyMsg(null);
    const updated = { ...config, nexusApiKey: apiKey.trim() };
    await invoke('save_config', { config: updated });
    onConfigChange(updated);
    setKeyMsg({ ok: true, text: 'Saved.' });
    setTimeout(() => setKeyMsg(null), 2000);
  }

  return (
    <div className="settings-scroll">
      <div className="settings-body">

        {/* Theme */}
        <section className="settings-section">
          <h3>Theme</h3>
          <p className="settings-hint">Pick an accent color for the interface.</p>
          <div className="theme-swatches">
            {PRESETS.map(p => (
              <button
                key={p.id}
                className={`theme-swatch${accent === p.accent ? ' active' : ''}`}
                style={{ '--swatch': p.accent }}
                onClick={() => pickTheme(p.accent)}
                title={p.label}
              />
            ))}
            <label
              className={`theme-swatch custom${!PRESETS.some(p => p.accent === accent) ? ' active' : ''}`}
              style={{ '--swatch': accent }}
              title="Custom color"
            >
              <input type="color" value={accent} onChange={e => pickTheme(e.target.value)} />
              <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="rgba(255,255,255,0.7)" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" style={{position:'relative',zIndex:1,pointerEvents:'none'}}>
                <path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/>
              </svg>
            </label>
          </div>
        </section>

        {/* App Updates */}
        <section className="settings-section">
          <h3>App Updates</h3>
          <div style={{display:'flex', alignItems:'center', gap:'10px', flexWrap:'wrap'}}>
            <span style={{fontSize:'12px', color:'var(--text2)'}}>
              Current version: <strong style={{color:'var(--text)'}}>{appVersion || '…'}</strong>
            </span>
            {updateInfo === null ? (
              <span style={{fontSize:'12px', color:'var(--text3)'}}>Checking…</span>
            ) : updateInfo.available ? (
              <span style={{fontSize:'12px', color:'var(--success)', fontWeight:600}}>
                Update available: v{updateInfo.version}
              </span>
            ) : (
              <span style={{fontSize:'12px', color:'var(--text3)'}}>Up to date</span>
            )}
            {!updateInfo?.available && (
              <button className="btn-ghost sm" onClick={onRecheckUpdate} disabled={updateInfo === null}>
                Check for updates
              </button>
            )}
          </div>
          {updateInfo?.available && (
            <>
              {updateInfo.notes && (
                <p className="settings-hint" style={{marginTop:'8px', whiteSpace:'pre-wrap'}}>{updateInfo.notes}</p>
              )}
              <div className="settings-row" style={{marginTop:'10px'}}>
                <button className="btn-primary sm" onClick={doInstallUpdate} disabled={installing}>
                  {installing ? 'Downloading & installing…' : `Update to v${updateInfo.version} and restart`}
                </button>
              </div>
            </>
          )}
        </section>

        {/* Nexus Account */}
        <section className="settings-section">
          <h3>Nexus Account</h3>
          <p className="settings-hint">
            Sign in with your Nexus Mods account to install mods without needing to manage an API key manually.
          </p>
          <div className="nexus-login-box">
            <button className="btn-ghost sm" disabled style={{opacity:0.45, cursor:'not-allowed'}}>
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4"/><polyline points="10 17 15 12 10 7"/><line x1="15" y1="12" x2="3" y2="12"/>
              </svg>
              Sign in with Nexus Mods
            </button>
            <span className="nexus-login-pending">
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{flexShrink:0}}>
                <circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>
              </svg>
              Waiting for Nexus approval — coming soon
            </span>
          </div>
        </section>

        {/* Mods Folder */}
        <section className="settings-section">
          <h3>Mods Folder</h3>
          <p className="settings-hint">Location of your UE4SS Mods directory inside the Subnautica 2 installation.</p>
          <div className="input-row">
            <input className="input mono" value={folder} onChange={e => setFolder(e.target.value)} spellCheck={false} />
            <button className="btn-ghost" onClick={browseFolder}>Browse</button>
          </div>
          <div className="settings-row">
            <button className="btn-primary sm" onClick={saveFolder}>Save Changes</button>
            {folderMsg && <span className="save-ok" style={folderMsg.ok ? {} : {color:'var(--error)'}}>{folderMsg.text}</span>}
          </div>
        </section>

        {/* Download Directory */}
        <section className="settings-section">
          <h3>Download Directory</h3>
          <p className="settings-hint">Where Tidekeeper saves mod ZIPs downloaded via "Mod Manager Download". Leave blank to use the default app data folder.</p>
          <div className="input-row">
            <input className="input mono" value={downloadDir} onChange={e => setDownloadDir(e.target.value)} spellCheck={false} placeholder="Default (app data folder)" />
            <button className="btn-ghost" onClick={browseDownloadDir}>Browse</button>
          </div>
          <div className="settings-row">
            <button className="btn-primary sm" onClick={saveDownloadDir}>Save Changes</button>
            {dlMsg && <span className="save-ok" style={dlMsg.ok ? {} : {color:'var(--error)'}}>{dlMsg.text}</span>}
          </div>
        </section>

        {/* Nexus API Key */}
        <section className="settings-section">
          <h3>Nexus Mods API Key</h3>
          <p className="settings-hint">
            Your personal API key lets the app browse and install mods from Nexus on your behalf.
            Find it at{' '}
            <a onClick={() => openUrl('https://next.nexusmods.com/settings/api-keys')} style={{cursor:'pointer'}}>
              next.nexusmods.com → Settings → API Keys
            </a>
            {' '}under <strong>Personal API Key</strong>.
          </p>
          <div className="input-row">
            <input
              className="input mono"
              placeholder="Paste your API key here…"
              value={apiKey}
              onChange={e => setApiKey(e.target.value)}
              spellCheck={false}
              type="password"
            />
            <button className="btn-ghost" onClick={saveApiKey}>Save</button>
          </div>
          {keyMsg && <p style={{marginTop:'8px', fontSize:'12px', color: keyMsg.ok ? 'var(--success)' : 'var(--error)'}}>{keyMsg.text}</p>}
        </section>

      </div>
    </div>
  );
}
