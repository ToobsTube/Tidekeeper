import { useState, useEffect } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { open } from '@tauri-apps/plugin-dialog';
import { openUrl } from '@tauri-apps/plugin-opener';

export default function SetupView({ onComplete }) {
  const [step, setStep]             = useState(1);
  const [gamePath, setGamePath]     = useState('');
  const [gameError, setGameError]   = useState('');
  const [busy, setBusy]             = useState(false);
  const [ue4ssOk, setUe4ssOk]      = useState(null);
  const [installing, setInstalling] = useState(false);
  const [installMsg, setInstallMsg] = useState(null);

  // Try to auto-detect on first load
  useEffect(() => {
    invoke('find_subnautica2').then(p => { if (p) setGamePath(p); }).catch(() => {});
  }, []);

  async function browseGame() {
    const p = await open({ directory: true, title: 'Select Subnautica 2 Install Folder' });
    if (p) { setGamePath(p); setGameError(''); }
  }

  async function continueStep1() {
    setBusy(true);
    setGameError('');
    try {
      const modsPath = await invoke('create_mod_structure', { gameFolder: gamePath });
      await invoke('save_config', { config: { modsFolder: modsPath, setupComplete: true } });
      setUe4ssOk(await invoke('check_ue4ss'));
      setStep(2);
    } catch (e) {
      setGameError(String(e));
    }
    setBusy(false);
  }

  async function installFromZip() {
    const p = await open({
      filters: [{ name: 'Archives', extensions: ['zip', '7z', 'rar'] }],
      title: 'Select UE4SS ZIP',
    });
    if (!p) return;
    setInstalling(true);
    setInstallMsg(null);
    try {
      await invoke('install_from_zip', { zipPath: p, modName: 'UE4SS' });
      setUe4ssOk(true);
      setInstallMsg({ ok: true, text: 'UE4SS installed successfully.' });
    } catch (e) {
      setInstallMsg({ ok: false, text: String(e) });
    }
    setInstalling(false);
  }

  async function finish() {
    onComplete(await invoke('get_config'));
  }

  const ArrowIcon = () => (
    <svg width="15" height="15" viewBox="0 0 16 16" fill="none">
      <path d="M3 8h10M9 4l4 4-4 4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"/>
    </svg>
  );

  // ── Step 1: Find Subnautica 2 ───────────────────────────────────────────────
  if (step === 1) return (
    <div className="setup-center">
      <div className="setup-card">
        <span className="setup-logo">◈</span>
        <h1>Tidekeeper</h1>
        <p className="sub">First, let's find your Subnautica 2 installation.</p>

        <div className="field">
          <label>Game Install Folder</label>
          {gamePath ? (
            <div className="input-row">
              <input
                className="input mono"
                value={gamePath}
                onChange={e => { setGamePath(e.target.value); setGameError(''); }}
                spellCheck={false}
              />
              <button className="btn-ghost" onClick={browseGame}>Browse</button>
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
              <p style={{ margin: 0, fontSize: '13px', color: 'var(--text2)' }}>
                Not detected automatically. Browse to your Subnautica 2 folder inside Steam.
              </p>
              <div style={{ display: 'flex', gap: '8px' }}>
                <button className="btn-ghost" onClick={() =>
                  invoke('find_subnautica2').then(p => { if (p) setGamePath(p); })
                }>
                  Auto-detect
                </button>
                <button className="btn-ghost" onClick={browseGame}>Browse</button>
              </div>
            </div>
          )}
          {gameError && <p className="field-error">{gameError}</p>}
          <p style={{ margin: '8px 0 0', fontSize: '11px', color: 'var(--text3)' }}>
            Usually: <span className="mono">SteamLibrary\steamapps\common\Subnautica2</span>
          </p>
        </div>

        <div className="form-actions">
          <button className="btn-primary" onClick={continueStep1} disabled={!gamePath || busy}>
            {busy ? 'Setting up…' : 'Continue'} {!busy && <ArrowIcon />}
          </button>
        </div>
      </div>
    </div>
  );

  // ── Step 2: Install UE4SS ───────────────────────────────────────────────────
  if (step === 2) return (
    <div className="setup-center">
      <div className="setup-card">
        <span className="setup-logo">◈</span>
        <h1>Install UE4SS</h1>
        <p className="sub">
          UE4SS is required for script mods. Pak and blueprint mods work without it.
        </p>

        {ue4ssOk ? (
          <div style={{
            display: 'flex', alignItems: 'center', gap: '8px',
            padding: '12px 14px', borderRadius: '6px', marginBottom: '16px',
            background: 'rgba(0,200,100,0.08)', border: '1px solid rgba(0,200,100,0.2)',
          }}>
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="var(--success, #00c864)" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="20 6 9 17 4 12"/>
            </svg>
            <span style={{ fontSize: '13px', color: 'var(--success, #00c864)' }}>
              UE4SS is already installed — you're good to go.
            </span>
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '12px', marginBottom: '16px' }}>
            <p style={{ margin: 0, fontSize: '13px', color: 'var(--text2)' }}>
              Download the <strong>SN2-specific UE4SS build</strong> from Nexus, then select
              the downloaded ZIP below — Tidekeeper will install it automatically.
            </p>
            <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
              <button className="btn-ghost sm" onClick={() =>
                openUrl('https://www.nexusmods.com/subnautica2/mods/36')
              }>
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
                  <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>
                  <polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/>
                </svg>
                Open Nexus Page
              </button>
              <button className="btn-ghost sm" onClick={installFromZip} disabled={installing}>
                {installing ? 'Installing…' : 'Select Downloaded ZIP'}
              </button>
            </div>
            {installMsg && (
              <p style={{
                margin: 0, fontSize: '12px',
                color: installMsg.ok ? 'var(--success, #00c864)' : 'var(--error)',
              }}>
                {installMsg.text}
              </p>
            )}
          </div>
        )}

        <div className="form-actions" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '10px' }}>
          {!ue4ssOk && (
            <button className="btn-ghost sm" style={{ opacity: 0.7 }} onClick={() => setStep(3)}>
              Skip — pak mods only
            </button>
          )}
          <button className="btn-primary" onClick={() => setStep(3)}>
            Continue <ArrowIcon />
          </button>
        </div>
      </div>
    </div>
  );

  // ── Step 3: Done ────────────────────────────────────────────────────────────
  return (
    <div className="setup-center">
      <div className="setup-card">
        <span className="setup-logo">◈</span>
        <h1>You're all set!</h1>
        <p className="sub">Tidekeeper is ready to manage your Subnautica 2 mods.</p>
        {!ue4ssOk && (
          <p style={{ fontSize: '12px', color: 'var(--text3)', margin: '0 0 16px' }}>
            You can install UE4SS later using the Diagnostics tab or the + Install ZIP button.
          </p>
        )}
        <div className="form-actions">
          <button className="btn-primary" onClick={finish}>
            Start Managing Mods <ArrowIcon />
          </button>
        </div>
      </div>
    </div>
  );
}
