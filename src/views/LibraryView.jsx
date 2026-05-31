import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { open, save } from '@tauri-apps/plugin-dialog';
import { openUrl, openPath } from '@tauri-apps/plugin-opener';
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
  const [ue4ssOk, setUe4ssOk]       = useState(true);
  const [unmanaged, setUnmanaged]   = useState([]);
  const [dismissed, setDismissed]   = useState(new Set());
  const [adoptNames, setAdoptNames] = useState({});
  const [diagRunning, setDiagRunning] = useState(false);
  const [diagResults, setDiagResults] = useState(null);
  const [diagTab, setDiagTab]         = useState('check');
  const [logLines, setLogLines]       = useState(null);
  const [ue4ssLog, setUe4ssLog]       = useState(null);
  const [packPreview, setPackPreview]   = useState(null); // { path, mods }
  const [packInstalling, setPackInstalling] = useState(false);
  const [packCreateProfile, setPackCreateProfile] = useState(true);
  const [packProfileName, setPackProfileName]     = useState('');
  const [updateStatuses, setUpdateStatuses] = useState({}); // modPath → ModUpdateStatus
  const [checkingUpdates, setCheckingUpdates] = useState(false);
  const [verifyResults, setVerifyResults] = useState({}); // modPath → { ok, missing }

  // Detect enabled mods that share the same Nexus mod_id (variant conflicts)
  const conflictGroups = useMemo(() => {
    if (!mods) return [];
    const byModId = {};
    for (const mod of mods) {
      if (!mod.meta?.modId || !mod.enabled) continue;
      const id = mod.meta.modId;
      if (!byModId[id]) byModId[id] = [];
      byModId[id].push(mod);
    }
    return Object.values(byModId).filter(g => g.length > 1);
  }, [mods]);

  const conflictPaths = useMemo(() => {
    const set = new Set();
    for (const group of conflictGroups) for (const m of group) set.add(m.path);
    return set;
  }, [conflictGroups]);

  // Profile state
  const profiles  = config?.profiles ?? {};
  const profileNames = Object.keys(profiles);
  const active    = config?.activeProfile ?? '';
  const [newName, setNewName]   = useState('');
  const [showNew, setShowNew]   = useState(false);

  useEffect(() => {
    if (!config?.modsFolder) return;
    invoke('check_ue4ss').then(ok => setUe4ssOk(ok));
  }, [config?.modsFolder]);

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const [modList, unmanagedList] = await Promise.all([
        invoke('scan_mods'),
        invoke('get_unmanaged_paks'),
      ]);
      setMods(modList);
      setUnmanaged(unmanagedList);
      setAdoptNames(Object.fromEntries(unmanagedList.map(g => [g.suggestedName, g.suggestedName])));
    }
    catch (err) { setError(String(err)); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { load(); }, [load]);

  // Auto-refresh when an NXM download completes so new badges appear immediately
  useEffect(() => {
    let unlisten;
    listen('nxm-installed', () => load()).then(fn => { unlisten = fn; });
    return () => { unlisten?.(); };
  }, [load]);

  // File drop via Tauri window events
  useEffect(() => {
    const win = getCurrentWindow();
    let unlisten;
    win.listen('tauri://file-drop', async e => {
      const paths = e.payload?.paths ?? e.payload ?? [];
      const zip = paths.find(p => /\.(zip|7z|rar)$/i.test(p));
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
      invoke('check_ue4ss').then(ok => setUe4ssOk(ok));
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

  const fmtTs = ts => {
    const d = new Date(ts * 1000);
    const p = n => String(n).padStart(2, '0');
    return `${d.getMonth()+1}/${d.getDate()} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
  };

  async function runDiagnostics() {
    setDiagRunning(true);
    setDiagResults(null);
    setDiagTab('check');
    setLogLines(null);
    setUe4ssLog(null);
    try {
      const [results, log] = await Promise.all([invoke('run_diagnostics'), invoke('get_log')]);
      setDiagResults(results);
      setLogLines(log);
    } catch (e) {
      setDiagResults([{ severity: 'error', title: 'Diagnostics failed', detail: String(e) }]);
    } finally {
      setDiagRunning(false);
    }
  }

  async function loadUe4ssLog() {
    setUe4ssLog({ loading: true });
    try {
      const text = await invoke('get_ue4ss_log');
      setUe4ssLog({ text });
    } catch (e) {
      setUe4ssLog({ error: String(e) });
    }
  }

  function switchDiagTab(tab) {
    setDiagTab(tab);
    if (tab === 'ue4ss' && ue4ssLog === null) loadUe4ssLog();
  }

  async function exportReport() {
    const path = await save({
      defaultPath: 'tidekeeper-report.txt',
      filters: [{ name: 'Text File', extensions: ['txt'] }],
      title: 'Save Diagnostic Report',
    });
    if (!path) return;
    try {
      await invoke('export_report', {
        exportPath: path,
        generatedAt: new Date().toLocaleString(),
      });
    } catch (e) { alert(`Export failed: ${e}`); }
  }

  async function clearLog() {
    try {
      await invoke('clear_log');
      setLogLines([]);
    } catch (e) { alert(`Clear log failed: ${e}`); }
  }

  async function adoptMod(group) {
    const modName = (adoptNames[group.suggestedName] || group.suggestedName).trim();
    if (!modName) return;
    try {
      await invoke('adopt_unmanaged_pak', { suggestedName: group.suggestedName, modName });
      await load();
    } catch (e) { alert(`Failed to adopt mod: ${e}`); }
  }

  function dismissMod(stem) {
    setDismissed(prev => new Set([...prev, stem]));
  }

  async function exportModPack() {
    if (!mods || mods.length === 0) { alert('No mods installed to export.'); return; }
    const path = await save({
      defaultPath: 'tidekeeper-modpack.tkpack',
      filters: [{ name: 'Tidekeeper Mod Pack', extensions: ['tkpack'] }],
      title: 'Save Mod Pack',
    });
    if (!path) return;
    try {
      const count = await invoke('export_modpack', { exportPath: path });
      setInstallMsg({ ok: true, text: `Exported ${count} mod${count !== 1 ? 's' : ''}` });
      setTimeout(() => setInstallMsg(null), 4000);
    } catch (e) { alert(`Export failed: ${e}`); }
  }

  async function importModPack() {
    const path = await open({
      filters: [{ name: 'Tidekeeper Mod Pack', extensions: ['tkpack'] }],
      title: 'Open Mod Pack',
    });
    if (!path) return;
    try {
      const mods = await invoke('peek_modpack', { archivePath: path });
      const fileName = path.replace(/\\/g, '/').split('/').pop().replace(/\.tkpack$/i, '');
      setPackProfileName(fileName);
      setPackCreateProfile(true);
      setPackPreview({ path, mods });
    } catch (e) { alert(`Could not read mod pack: ${e}`); }
  }

  async function installModPack() {
    if (!packPreview) return;
    setPackInstalling(true);
    try {
      const count = await invoke('install_modpack', { archivePath: packPreview.path });
      const profileName = packCreateProfile ? packProfileName.trim() : '';
      if (profileName) {
        await invoke('save_profile', { profileName });
        const cfg = await invoke('get_config');
        onConfigChange(cfg);
      }
      setPackPreview(null);
      const profileNote = profileName ? ` — saved as profile "${profileName}"` : '';
      setInstallMsg({ ok: true, text: `Installed ${count} mod${count !== 1 ? 's' : ''} from pack${profileNote}` });
      await load();
      invoke('check_ue4ss').then(ok => setUe4ssOk(ok));
      setTimeout(() => setInstallMsg(null), 6000);
    } catch (e) {
      alert(`Install failed: ${e}`);
    } finally {
      setPackInstalling(false);
    }
  }

  async function checkUpdates() {
    setCheckingUpdates(true);
    try {
      const statuses = await invoke('check_mod_updates');
      const map = {};
      for (const s of statuses) map[s.modPath] = s;
      setUpdateStatuses(map);
      const count = statuses.filter(s => s.hasUpdate).length;
      setInstallMsg({ ok: true, text: count > 0 ? `${count} update${count !== 1 ? 's' : ''} available` : 'All mods up to date' });
      setTimeout(() => setInstallMsg(null), 4000);
    } catch (e) {
      setInstallMsg({ ok: false, text: String(e) });
      setTimeout(() => setInstallMsg(null), 4000);
    } finally {
      setCheckingUpdates(false);
    }
  }

  async function verifyAll() {
    if (!mods) return;
    const results = {};
    for (const mod of mods) {
      const r = await invoke('verify_mod', { modPath: mod.path });
      if (r.missing.length > 0) results[mod.path] = r;
    }
    setVerifyResults(results);
    const bad = Object.keys(results).length;
    setInstallMsg(bad > 0
      ? { ok: false, text: `${bad} mod${bad !== 1 ? 's' : ''} have missing files` }
      : { ok: true, text: 'All mods verified OK' });
    setTimeout(() => setInstallMsg(null), 5000);
  }

  async function pickZip() {
    const selected = await open({ filters: [{ name: 'Mod Archive', extensions: ['zip', '7z', 'rar'] }], title: 'Select Mod Archive' });
    if (selected) await promptInstall(selected);
  }

  async function rollback(mod) {
    if (!confirm(`Roll back "${mod.name}" to the previous version? Current files will be replaced with the backup.`)) return;
    try {
      await invoke('rollback_mod', { modPath: mod.path });
      setInstallMsg(`Rolled back "${mod.name}" to previous version.`);
      loadMods();
    } catch (err) {
      setInstallMsg(`Rollback failed: ${err}`);
    }
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
          <button className="btn-ghost sm" onClick={checkUpdates} disabled={checkingUpdates || loading}>
            {checkingUpdates ? 'Checking…' : 'Check Updates'}
          </button>
          <button className="btn-ghost sm" onClick={verifyAll} disabled={loading || !mods?.length}>
            Verify Files
          </button>
          <button className="btn-ghost sm" onClick={exportModPack} disabled={installing || loading}>
            Export Pack
          </button>
          <button className="btn-ghost sm" onClick={importModPack} disabled={installing}>
            Import Pack
          </button>
          <button className="btn-ghost sm" onClick={pickZip} disabled={installing}>
            {installing ? 'Installing…' : '+ Install ZIP'}
          </button>
          <button className="btn-ghost sm" onClick={runDiagnostics} disabled={diagRunning || loading}>
            {diagRunning ? 'Scanning…' : 'Diagnostics'}
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

      {!ue4ssOk && (
        <div className="ue4ss-banner">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{flexShrink:0}}>
            <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/>
            <line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>
          </svg>
          <span>UE4SS is not installed — script mods won't load without it. Download it, then install via "+ Install ZIP" above.</span>
          <button className="btn-primary sm" onClick={() => openUrl('https://www.nexusmods.com/subnautica2/mods/36')} style={{marginLeft:'auto', flexShrink:0}}>
            Download UE4SS
          </button>
        </div>
      )}

      {conflictGroups.length > 0 && (
        <div className="conflict-banner">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{flexShrink:0}}>
            <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/>
            <line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>
          </svg>
          <div style={{display:'flex', flexDirection:'column', gap:'3px'}}>
            {conflictGroups.map((group, i) => (
              <span key={i}>
                <strong>Variant conflict:</strong> {group.map(m => m.meta?.displayName ?? m.name).join(' and ')} share the same mod — disable one to avoid issues.
              </span>
            ))}
          </div>
        </div>
      )}

      {unmanaged.filter(g => !dismissed.has(g.suggestedName)).length > 0 && (
        <div className="unmanaged-section">
          <div className="unmanaged-header">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{flexShrink:0}}>
              <circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/>
            </svg>
            <span>Unmanaged mod files found in LogicMods — Tidekeeper can't track or disable these until you take over.</span>
          </div>
          {unmanaged.filter(g => !dismissed.has(g.suggestedName)).map(group => (
            <div key={group.suggestedName} className="unmanaged-row">
              <div className="unmanaged-files">
                {group.files.map(f => <span key={f} className="unmanaged-file">{f}</span>)}
              </div>
              <input
                className="input"
                style={{width:'160px', flexShrink:0}}
                value={adoptNames[group.suggestedName] ?? group.suggestedName}
                onChange={e => setAdoptNames(prev => ({...prev, [group.suggestedName]: e.target.value}))}
                onKeyDown={e => { if (e.key === 'Enter') adoptMod(group); }}
                placeholder="Mod name…"
              />
              <button className="btn-primary sm" onClick={() => adoptMod(group)}
                disabled={!(adoptNames[group.suggestedName] ?? group.suggestedName).trim()}>
                Take Over
              </button>
              <button className="btn-ghost sm" onClick={() => dismissMod(group.suggestedName)}>Leave It</button>
            </div>
          ))}
        </div>
      )}

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
            <p>Drop archive to install</p>
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
          mods.map(mod => {
            const upd = updateStatuses[mod.path];
            return (
              <div key={mod.path} className={`mod-row${conflictPaths.has(mod.path) ? ' mod-row-conflict' : ''}${verifyResults[mod.path] ? ' mod-row-missing' : ''}`}>
                <span
                  className={`mod-row-name${mod.enabled ? '' : ' disabled'}`}
                  title={verifyResults[mod.path] ? `Missing: ${verifyResults[mod.path].missing.join(', ')}` : undefined}
                >
                  {mod.meta?.displayName ?? mod.name}
                  {mod.meta?.displayName && mod.meta.displayName !== mod.name && (
                    <span className="mod-row-foldername">{mod.name}</span>
                  )}
                </span>
                {mod.modType === 'pak' && <span className="mod-type-badge">PAK</span>}
                {mod.meta?.source === 'nexus' && (
                  mod.meta?.modId
                    ? <button
                        className="mod-source-badge mod-source-link"
                        title="Open mod page on Nexus"
                        onClick={() => openUrl(`https://www.nexusmods.com/subnautica2/mods/${mod.meta.modId}`)}
                      >Nexus ↗</button>
                    : <span className="mod-source-badge">Nexus</span>
                )}
                {mod.meta?.fileName && <span className="mod-variant-badge" title={mod.meta.fileName}>{mod.meta.fileName}</span>}
                {mod.meta?.version && <span className="mod-version-badge">v{mod.meta.version}</span>}
                {upd?.hasUpdate && (
                  <span className="mod-update-badge" title={`Update available: v${upd.latestVersion}`}>
                    ↑ Update
                  </span>
                )}
                {(() => {
                  const activeConfigs = mod.configFiles?.filter(f => !f.endsWith('.new')) ?? [];
                  const newConfigs    = mod.configFiles?.filter(f => f.endsWith('.new')) ?? [];
                  return (<>
                    {activeConfigs.length > 0 && (
                      <button
                        className="btn-config"
                        title="Edit config file"
                        onClick={() => openPath(activeConfigs[0]).catch(e => console.error('openPath failed:', e))}
                      >⚙</button>
                    )}
                    {newConfigs.length > 0 && (
                      <button
                        className="btn-config btn-config-new"
                        title="View new default config (from update) — compare with your settings"
                        onClick={() => openPath(newConfigs[0]).catch(e => console.error('openPath failed:', e))}
                      >⚙ new</button>
                    )}
                  </>);
                })()}
                {mod.hasBackup && (
                  <button
                    className="btn-rollback"
                    title="Roll back to previous version"
                    onClick={() => rollback(mod)}
                  >↩</button>
                )}
                <label className="toggle" title={mod.enabled ? 'Disable mod' : 'Enable mod'}>
                  <input type="checkbox" checked={mod.enabled} onChange={e => toggle(mod, e.target.checked)} />
                  <span className="toggle-track" />
                </label>
                <button className="btn-uninstall" onClick={() => uninstall(mod)}>Uninstall</button>
              </div>
            );
          })
        )}
      </div>

      {diagResults && (
        <div className="modal-backdrop" onClick={() => setDiagResults(null)}>
          <div className="modal" onClick={e => e.stopPropagation()}>
            <div className="modal-header">
              <span className="modal-title">Diagnostics</span>
              <div className="source-toggle" style={{margin:'0 auto 0 14px'}}>
                <button className={`source-btn sm${diagTab === 'check' ? ' active' : ''}`} onClick={() => switchDiagTab('check')}>Checks</button>
                <button className={`source-btn sm${diagTab === 'log' ? ' active' : ''}`} onClick={() => switchDiagTab('log')}>Log</button>
                <button className={`source-btn sm${diagTab === 'ue4ss' ? ' active' : ''}`} onClick={() => switchDiagTab('ue4ss')}>UE4SS Log</button>
              </div>
              <button className="modal-close" onClick={() => setDiagResults(null)}>✕</button>
            </div>

            {diagTab === 'check' ? (
              <div className="diag-list">
                {diagResults.map((issue, i) => (
                  <div key={i} className={`diag-issue diag-${issue.severity}`}>
                    <span className="diag-dot" />
                    <div className="diag-body">
                      <span className="diag-title">{issue.title}</span>
                      <span className="diag-detail">{issue.detail}</span>
                    </div>
                  </div>
                ))}
              </div>
            ) : diagTab === 'log' ? (
              <div className="log-list">
                {!logLines || logLines.length === 0 ? (
                  <p style={{color:'var(--text3)', fontSize:'12px', padding:'16px 0', textAlign:'center'}}>
                    {logLines === null ? 'Loading…' : 'Log is empty.'}
                  </p>
                ) : logLines.map((line, i) => (
                  <div key={i} className="log-entry">
                    <span className="log-ts">{fmtTs(line.ts)}</span>
                    <span className={`log-level log-level-${line.level.toLowerCase()}`}>{line.level}</span>
                    <span className="log-msg">{line.message}</span>
                  </div>
                ))}
              </div>
            ) : (
              <div className="ue4ss-log-wrap">
                {!ue4ssLog || ue4ssLog.loading ? (
                  <p style={{color:'var(--text3)', fontSize:'12px', padding:'16px 0', textAlign:'center'}}>
                    {ue4ssLog?.loading ? 'Loading…' : 'Select this tab to load.'}
                  </p>
                ) : ue4ssLog.error ? (
                  <p style={{color:'var(--error)', fontSize:'12px', padding:'12px 0'}}>{ue4ssLog.error}</p>
                ) : (
                  <pre className="ue4ss-log-content">
                    {ue4ssLog.text.split('\n').map((line, i) => {
                      const lower = line.toLowerCase();
                      const cls = lower.includes('error') ? 'ue4ss-line-error'
                                : lower.includes('warn')  ? 'ue4ss-line-warn'
                                : '';
                      return <span key={i} className={cls}>{line}{'\n'}</span>;
                    })}
                  </pre>
                )}
              </div>
            )}

            <div style={{display:'flex', justifyContent:'space-between', marginTop:'8px'}}>
              <div style={{display:'flex', gap:'6px'}}>
                {diagTab === 'log' && <button className="btn-ghost sm" onClick={clearLog}>Clear Log</button>}
                {diagTab === 'ue4ss' && <button className="btn-ghost sm" onClick={loadUe4ssLog}>Refresh</button>}
                <button className="btn-primary sm" onClick={exportReport}>Export Report</button>
              </div>
              <button className="btn-ghost sm" onClick={() => setDiagResults(null)}>Close</button>
            </div>
          </div>
        </div>
      )}

      {packPreview && (
        <div className="modal-backdrop" onClick={() => { if (!packInstalling) setPackPreview(null); }}>
          <div className="modal" onClick={e => e.stopPropagation()}>
            <div className="modal-header">
              <span className="modal-title">Install Mod Pack</span>
              <button className="modal-close" onClick={() => setPackPreview(null)} disabled={packInstalling}>✕</button>
            </div>
            <p style={{fontSize:'13px', color:'var(--text2)', margin:'0 0 10px'}}>
              {packPreview.mods.length} mod{packPreview.mods.length !== 1 ? 's' : ''} — existing mods with the same name will be overwritten.
            </p>
            {(() => {
              const installed = new Set((mods || []).map(m => m.name.toLowerCase()));
              const conflicts = packPreview.mods.filter(m => installed.has(m.name.toLowerCase())).length;
              return conflicts > 0 && (
                <p style={{fontSize:'12px', color:'var(--error)', margin:'0 0 8px'}}>
                  {conflicts} mod{conflicts !== 1 ? 's' : ''} already installed — {conflicts !== 1 ? 'those' : 'that'} will be overwritten.
                </p>
              );
            })()}
            <div className="pack-mod-list">
              {(() => {
                const installed = new Set((mods || []).map(m => m.name.toLowerCase()));
                return packPreview.mods.map((m, i) => (
                  <div key={i} className="pack-mod-row">
                    <span className="pack-mod-name">{m.name}</span>
                    {m.modType === 'pak' && <span className="mod-type-badge">PAK</span>}
                    {installed.has(m.name.toLowerCase()) && <span className="pack-conflict-badge">Installed</span>}
                    <span className="pack-mod-state">{m.enabled ? 'Enabled' : 'Disabled'}</span>
                  </div>
                ));
              })()}
            </div>
            <div style={{display:'flex', alignItems:'center', gap:'10px', marginTop:'12px', padding:'10px 12px', background:'var(--bg3)', borderRadius:'var(--r-sm)', border:'1px solid var(--border2)'}}>
              <label className="toggle" style={{flexShrink:0}}>
                <input type="checkbox" checked={packCreateProfile} onChange={e => setPackCreateProfile(e.target.checked)} />
                <span className="toggle-track" />
              </label>
              <span style={{fontSize:'12px', color:'var(--text2)', flexShrink:0}}>Save as profile</span>
              {packCreateProfile && (
                <input
                  className="input"
                  style={{flex:1, minWidth:0}}
                  value={packProfileName}
                  onChange={e => setPackProfileName(e.target.value)}
                  placeholder="Profile name…"
                />
              )}
            </div>
            <div style={{display:'flex', gap:'8px', marginTop:'8px', justifyContent:'flex-end'}}>
              <button className="btn-ghost sm" onClick={() => setPackPreview(null)} disabled={packInstalling}>Cancel</button>
              <button className="btn-primary sm" onClick={installModPack} disabled={packInstalling || (packCreateProfile && !packProfileName.trim())}>
                {packInstalling ? 'Installing…' : 'Install All'}
              </button>
            </div>
          </div>
        </div>
      )}

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
