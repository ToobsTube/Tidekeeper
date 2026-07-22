import { useState, useEffect } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { open } from '@tauri-apps/plugin-dialog';
import { openUrl } from '@tauri-apps/plugin-opener';
import { getVersion } from '@tauri-apps/api/app';
import { PRESETS, saveTheme } from '../utils/theme';

export default function SettingsView({ config, onConfigChange, updateInfo, onRecheckUpdate }) {
  const [folder, setFolder]           = useState(config?.modsFolder ?? '');
  const [downloadDir, setDownloadDir] = useState(config?.downloadDir ?? '');
  const [folderMsg, setFolderMsg]     = useState(null);
  const [dlMsg, setDlMsg]             = useState(null);
  const [appVersion, setAppVersion]   = useState('');
  const [installing, setInstalling]   = useState(false);
  const [accent, setAccent]           = useState(() => localStorage.getItem('tk-accent') ?? '#00d4ff');
  const [authStatus, setAuthStatus]   = useState({ signedIn: false, username: null, isPremium: false });
  const [signingIn, setSigningIn]     = useState(false);
  const [oauthError, setOauthError]   = useState(null);

  useState(() => { getVersion().then(v => setAppVersion(v)).catch(() => {}); });

  useEffect(() => {
    invoke('nexus_get_auth_status').then(setAuthStatus).catch(() => {});

    let unlisten1, unlisten2;
    listen('nexus-oauth-complete', e => {
      setAuthStatus({ signedIn: true, username: e.payload.username, isPremium: e.payload.isPremium });
      setSigningIn(false);
      setOauthError(null);
      invoke('get_config').then(cfg => { if (cfg) onConfigChange(cfg); }).catch(() => {});
    }).then(fn => { unlisten1 = fn; });
    listen('nexus-oauth-error', e => {
      setOauthError(typeof e.payload === 'string' ? e.payload : 'Sign-in failed — please try again.');
      setSigningIn(false);
    }).then(fn => { unlisten2 = fn; });

    return () => { unlisten1?.(); unlisten2?.(); };
  }, []);

  async function doSignIn() {
    setSigningIn(true);
    setOauthError(null);
    try {
      const url = await invoke('nexus_oauth_login');
      await openUrl(url);
    } catch (e) {
      setOauthError(String(e));
      setSigningIn(false);
    }
  }

  async function doSignOut() {
    await invoke('nexus_oauth_logout').catch(() => {});
    setAuthStatus({ signedIn: false, username: null, isPremium: false });
  }

  function pickTheme(color) {
    setAccent(color);
    saveTheme(color);
  }

  async function doInstallUpdate() {
    const isPremium = authStatus.isPremium || config?.nexusIsPremium;
    if (!isPremium) {
      openUrl('https://www.nexusmods.com/subnautica2/mods/343?tab=files');
      return;
    }
    setInstalling(true);
    try {
      await invoke('install_update', { fileId: updateInfo.fileId });
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
                {(authStatus.isPremium || config?.nexusIsPremium) ? (
                  <button className="btn-primary sm" onClick={doInstallUpdate} disabled={installing}>
                    {installing ? 'Downloading & installing…' : `Update to v${updateInfo.version} and restart`}
                  </button>
                ) : (
                  <button className="btn-primary sm" onClick={doInstallUpdate}>
                    {`Download v${updateInfo.version} on Nexus`}
                  </button>
                )}
              </div>
            </>
          )}
        </section>

        {/* Nexus Account */}
        <section className="settings-section">
          <h3>Nexus Account</h3>
          {authStatus.signedIn ? (
            <>
              <div style={{display:'flex', alignItems:'center', gap:'8px', marginBottom:'10px', flexWrap:'wrap'}}>
                <span style={{fontSize:'13px', color:'var(--text)'}}>
                  Signed in as <strong>{authStatus.username}</strong>
                </span>
                {authStatus.isPremium && (
                  <span style={{
                    fontSize:'10px', fontWeight:700, letterSpacing:'0.05em',
                    padding:'2px 6px', borderRadius:'4px',
                    background:'var(--accent)', color:'#000',
                  }}>PREMIUM</span>
                )}
              </div>
              <div className="settings-row">
                <button className="btn-ghost sm" onClick={doSignOut}>Sign out</button>
              </div>
            </>
          ) : (
            <>
              <p className="settings-hint">
                Sign in with your Nexus account to browse and install mods.
                Premium members also get automatic in-app updates.
              </p>
              <div className="settings-row">
                <button className="btn-primary sm" onClick={doSignIn} disabled={signingIn}>
                  {signingIn ? 'Opening browser…' : 'Sign in with Nexus'}
                </button>
                {oauthError && <span style={{fontSize:'12px', color:'var(--error)', marginLeft:'10px'}}>{oauthError}</span>}
              </div>
            </>
          )}
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

      </div>
    </div>
  );
}
