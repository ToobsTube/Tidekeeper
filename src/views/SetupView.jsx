import { useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { open } from '@tauri-apps/plugin-dialog';

const DEFAULT_PATH = 'F:\\SteamLibrary\\steamapps\\common\\Subnautica2\\Subnautica2\\Binaries\\Win64\\ue4ss\\Mods';

export default function SetupView({ onComplete }) {
  const [folder, setFolder] = useState(DEFAULT_PATH);
  const [error, setError]   = useState('');
  const [saving, setSaving] = useState(false);

  async function browse() {
    const selected = await open({ directory: true, title: 'Select UE4SS Mods Folder' });
    if (selected) { setFolder(selected); setError(''); }
  }

  async function handleSubmit(e) {
    e.preventDefault();
    setError('');
    const path = folder.trim();
    if (!path) { setError('Path is required.'); return; }

    const valid = await invoke('validate_folder', { path });
    if (!valid) { setError('Folder not found — check the path or use Browse.'); return; }

    setSaving(true);
    const config = { modsFolder: path, setupComplete: true };
    try {
      await invoke('save_config', { config });
      onComplete(config);
    } catch (err) {
      setError(String(err));
      setSaving(false);
    }
  }

  return (
    <div className="setup-center">
      <div className="setup-card">
        <span className="setup-logo">◈</span>
        <h1>SubnauticaMods</h1>
        <p className="sub">Confirm your UE4SS mods folder to get started.</p>

        <form onSubmit={handleSubmit}>
          <div className="field">
            <label>Mods Folder</label>
            <div className="input-row">
              <input
                className="input mono"
                value={folder}
                onChange={e => setFolder(e.target.value)}
                spellCheck={false}
                autoComplete="off"
              />
              <button type="button" className="btn-ghost" onClick={browse}>Browse</button>
            </div>
            {error && <p className="field-error">{error}</p>}
          </div>

          <div className="form-actions">
            <button className="btn-primary" type="submit" disabled={saving}>
              {saving ? 'Saving…' : 'Continue'}
              {!saving && (
                <svg width="15" height="15" viewBox="0 0 16 16" fill="none">
                  <path d="M3 8h10M9 4l4 4-4 4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"/>
                </svg>
              )}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
