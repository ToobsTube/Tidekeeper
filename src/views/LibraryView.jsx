import { useState, useEffect, useCallback, useRef } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { open, save } from '@tauri-apps/plugin-dialog';
import { getCurrentWindow } from '@tauri-apps/api/window';

export default function LibraryView({ config, onConfigChange }) {
  const [mods, setMods]         = useState(null);
  const [error, setError]       = useState(null);
  const [loading, setLoading]   = useState(true);
  const [dragging, setDragging] = useState(false);
  const [installing, setInstalling] = useState(false);
  const [installMsg, setInstallMsg] = useState(null);
  const [pendingZip, setPendingZip] = useState(null);
  const [pendingName, setPendingName] = useState('');
  const [pendingType, setPendingType] = useState('');

  // Profile state
  const profiles  = config?.profiles ?? {};
  const profileNames = Object.keys(profiles);
  const active    = config?.activeProfile ?? '';
  const [newName, setNewName]   = useState('');
  const [showNew, setShowNew]   = useState(false);

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try { setMods(await invoke('scan_mods')); }
    catch (err) { setError(String(err)); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { load(); }, [load]);

  // File drop via Tauri window events
  useEffect(() => {
    const win = getCurrentWindow();
    let unlisten;
    win.listen('tauri://file-drop', async e => {
      const paths = e.payload?.paths ?? e.payload ?? [];
      const zip = paths.find(p => p.toLowerCase().endsWith('.zip'));
      if (zip) await promptInstall(zip);
    }).then(fn => { unlisten = fn; });
    return () => { if (unlisten) unlisten(); };
  }, []);

  async function doInstall(zipPath, modName) {
    setInstalling(true); setInstallMsg(null);
    try {
      const name = await invoke('install_from_zip', { zipPath, modName });
      setInstallMsg({ ok: true, text: `Installed: ${name}` });
      await load();
    } catch (e) {
      setInstallMsg({ ok: false, text: String(e) });
    } finally {
      setInstalling(false);
      setTimeout(() => setInstallMsg(null), 4000);
    }
  }

  async function promptInstall(zipPath) {
    try {
      const info = await invoke('peek_zip_name', { zipPath });
      if (!info.needsNamePrompt) {
        // Good name found — install directly, no modal needed
        await doInstall(zipPath, info.suggestedName);
      } else {
        setPendingZip(zipPath);
        setPendingName(info.suggestedName);
        setPendingType(info.installType);
      }
    } catch {
      // Can't read ZIP — show prompt with empty name as fallback
      setPendingZip(zipPath);
      setPendingName('');
      setPendingType('');
    }
  }

  async function confirmInstall() {
    if (!pendingZip || !pendingName.trim()) return;
    const zipPath = pendingZip;
    const modName = pendingName.trim();
    setPendingZip(null);
    await doInstall(zipPath, modName);
  }

  async function pickZip() {
    const selected = await open({ filters: [{ name: 'Zip Archive', extensions: ['zip'] }], title: 'Select Mod ZIP' });
    if (selected) await promptInstall(selected);
  }

  async function toggle(mod, enabled) {
    try {
      const newPath = await invoke('toggle_mod', { modPath: mod.path, enabled });
      setMods(prev => prev.map(m => m.path === mod.path ? { ...m, enabled, path: newPath } : m));
    } catch (err) { console.error('Toggle failed:', err); }
  }

  async function uninstall(mod) {
    if (!confirm(`Uninstall "${mod.name}"?`)) return;
    try {
      await invoke('uninstall_mod', { modPath: mod.path });
      setMods(prev => prev.filter(m => m.path !== mod.path));
    } catch (err) { alert(`Uninstall failed: ${err}`); }
  }

  async function switchProfile(name) {
    try {
      await invoke('switch_profile', { profileName: name });
      const cfg = await invoke('get_config');
      onConfigChange(cfg);
      await load();
    } catch (e) { alert(`Failed to switch profile: ${e}`); }
  }

  async function saveProfile() {
    const name = newName.trim() || (active || 'Default');
    try {
      await invoke('save_profile', { profileName: name });
      const cfg = await invoke('get_config');
      onConfigChange(cfg);
      setNewName(''); setShowNew(false);
    } catch (e) { alert(`Failed to save profile: ${e}`); }
  }

  async function deleteProfile(name) {
    if (!confirm(`Delete profile "${name}"?`)) return;
    try {
      await invoke('delete_profile', { profileName: name });
      const cfg = await invoke('get_config');
      onConfigChange(cfg);
    } catch (e) { alert(`Failed to delete profile: ${e}`); }
  }

  async function exportProfile(name) {
    const path = await save({ defaultPath: `${name}.json`, filters: [{ name: 'JSON', extensions: ['json'] }] });
    if (!path) return;
    try {
      await invoke('export_profile', { profileName: name, exportPath: path });
    } catch (e) { alert(`Export failed: ${e}`); }
  }

  async function importProfile() {
    const path = await open({ filters: [{ name: 'JSON', extensions: ['json'] }], title: 'Import Profile' });
    if (!path) return;
    try {
      const name = await invoke('import_profile', { importPath: path });
      const cfg = await invoke('get_config');
      onConfigChange(cfg);
      alert(`Imported profile: ${name}`);
    } catch (e) { alert(`Import failed: ${e}`); }
  }

  return (
    <>
      <div className="pane-header" style={{flexWrap:'wrap', gap:'8px'}}>
        <h2 className="pane-title">Installed Mods</h2>
        <div style={{display:'flex', gap:'6px', marginLeft:'auto', alignItems:'center'}}>
          {installMsg && (
            <span style={{fontSize:'12px', color: installMsg.ok ? 'var(--success)' : 'var(--error)'}}>
              {installMsg.text}
            </span>
          )}
          <button className="btn-ghost sm" onClick={pickZip} disabled={installing}>
            {installing ? 'Installing…' : '+ Install ZIP'}
          </button>
          <button className="btn-ghost sm" onClick={load} disabled={loading}>
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="23 4 23 10 17 10"/>
              <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/>
            </svg>
            Refresh
          </button>
        </div>
      </div>

      {/* Profiles bar */}
      <div className="profiles-bar">
        <span className="profiles-label">Profile:</span>
        <div className="profiles-list">
          {profileNames.length === 0 && (
            <span className="profile-empty">No profiles saved</span>
          )}
          {profileNames.map(name => (
            <div key={name} className={`profile-chip${name === active ? ' active' : ''}`}>
              <button className="profile-chip-name" onClick={() => switchProfile(name)}>{name}</button>
              <button className="profile-chip-export" title="Export" onClick={() => exportProfile(name)}>↑</button>
              <button className="profile-chip-del" title="Delete" onClick={() => deleteProfile(name)}>✕</button>
            </div>
          ))}
        </div>
        <div style={{display:'flex', gap:'4px', marginLeft:'auto'}}>
          {showNew ? (
            <>
              <input
                className="input profile-input"
                placeholder="Profile name…"
                value={newName}
                onChange={e => setNewName(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') saveProfile(); if (e.key === 'Escape') setShowNew(false); }}
                autoFocus
              />
              <button className="btn-ghost sm" onClick={saveProfile}>Save</button>
              <button className="btn-ghost sm" onClick={() => setShowNew(false)}>✕</button>
            </>
          ) : (
            <>
              <button className="btn-ghost sm" onClick={() => setShowNew(true)} title="Save current state as new profile">+ Save Profile</button>
              <button className="btn-ghost sm" onClick={importProfile} title="Import profile from file">Import</button>
            </>
          )}
        </div>
      </div>

      <div
        className={`library-list${dragging ? ' drop-target' : ''}`}
        onDragOver={e => { e.preventDefault(); setDragging(true); }}
        onDragLeave={() => setDragging(false)}
        onDrop={e => { e.preventDefault(); setDragging(false); }}
      >
        {dragging ? (
          <div className="drop-overlay">
            <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
              <polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/>
            </svg>
            <p>Drop ZIP to install</p>
          </div>
        ) : loading ? (
          <div className="empty-state"><p style={{color:'var(--text3)'}}>Scanning mods folder…</p></div>
        ) : error ? (
          <div className="empty-state"><p style={{color:'var(--error)'}}>{error}</p></div>
        ) : !mods || mods.length === 0 ? (
          <div className="empty-state">
            <svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" style={{color:'var(--text3)'}}>
              <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/>
            </svg>
            <p>No mods installed. Click "+ Install ZIP" or drop a zip file here.</p>
          </div>
        ) : (
          mods.map(mod => (
            <div key={mod.path} className="mod-row">
              <span className={`mod-row-name${mod.enabled ? '' : ' disabled'}`}>{mod.name}</span>
              {mod.modType === 'pak' && <span className="mod-type-badge">PAK</span>}
              <label className="toggle" title={mod.enabled ? 'Disable mod' : 'Enable mod'}>
                <input type="checkbox" checked={mod.enabled} onChange={e => toggle(mod, e.target.checked)} />
                <span className="toggle-track" />
              </label>
              <button className="btn-uninstall" onClick={() => uninstall(mod)}>Uninstall</button>
            </div>
          ))
        )}
      </div>

      {pendingZip && (
        <div className="modal-backdrop" onClick={() => setPendingZip(null)}>
          <div className="modal" onClick={e => e.stopPropagation()}>
            <div className="modal-header">
              <span className="modal-title">Name this mod</span>
              <button className="modal-close" onClick={() => setPendingZip(null)}>✕</button>
            </div>
            <p className="modal-hint">No clear name was found in this ZIP. Give it a name so Tidekeeper can track and remove it correctly later.</p>
            <input
              className="input"
              value={pendingName}
              onChange={e => setPendingName(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') confirmInstall(); if (e.key === 'Escape') setPendingZip(null); }}
              autoFocus
            />
            <div style={{display:'flex', gap:'8px', marginTop:'12px', justifyContent:'flex-end'}}>
              <button className="btn-ghost sm" onClick={() => setPendingZip(null)}>Cancel</button>
              <button className="btn-primary sm" onClick={confirmInstall} disabled={!pendingName.trim()}>Install</button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
