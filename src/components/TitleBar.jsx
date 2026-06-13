import { useState, useEffect, useRef } from 'react';
import { getCurrentWindow } from '@tauri-apps/api/window';

export default function TitleBar({ environments = [], activeEnvId, onSwitch, onAddEnvironment, onRemoveEnvironment }) {
  const [maximized, setMaximized] = useState(false);
  const [open, setOpen] = useState(false);
  const dropdownRef = useRef(null);

  useEffect(() => {
    const win = getCurrentWindow();
    let unlisten;
    win.isMaximized().then(setMaximized);
    win.onResized(async () => setMaximized(await win.isMaximized())).then(fn => { unlisten = fn; });
    return () => { if (unlisten) unlisten(); };
  }, []);

  useEffect(() => {
    function handleClick(e) {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target)) setOpen(false);
    }
    if (open) document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [open]);

  const win = getCurrentWindow();
  const activeEnv = environments.find(e => e.id === activeEnvId);

  return (
    <div className="titlebar" data-tauri-drag-region>
      <div className="titlebar-left">
        <span className="titlebar-icon">◈</span>
        <span className="titlebar-name">Tidekeeper</span>
        {environments.length > 0 && (
          <div className="env-switcher" ref={dropdownRef} onClick={e => e.stopPropagation()}>
            <button className="env-current" onClick={() => setOpen(o => !o)}>
              <span><span style={{opacity:0.5, marginRight:'3px'}}>Install:</span>{activeEnv?.name ?? 'Select…'}</span>
              <svg width="8" height="5" viewBox="0 0 8 5" fill="none">
                <path d="M1 1l3 3 3-3" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round"/>
              </svg>
            </button>
            {open && (
              <div className="env-dropdown">
                {environments.map(env => (
                  <div key={env.id} className={`env-item${env.id === activeEnvId ? ' active' : ''}`}>
                    <span className="env-item-name" onClick={() => { onSwitch(env.id); setOpen(false); }}>
                      {env.name}
                    </span>
                    {env.id !== activeEnvId && environments.length > 1 && (
                      <button className="env-remove" title="Remove" onClick={() => onRemoveEnvironment(env.id)}>✕</button>
                    )}
                  </div>
                ))}
                <div className="env-add" onClick={() => { setOpen(false); onAddEnvironment(); }}>
                  + Add Environment
                </div>
              </div>
            )}
          </div>
        )}
      </div>
      <div className="titlebar-controls">
        <button className="titlebar-btn" onClick={() => win.minimize()} title="Minimize">
          <svg width="10" height="1" viewBox="0 0 10 1"><rect width="10" height="1" fill="currentColor"/></svg>
        </button>
        <button className="titlebar-btn" onClick={() => win.toggleMaximize()} title={maximized ? 'Restore' : 'Maximize'}>
          {maximized ? (
            <svg width="10" height="10" viewBox="0 0 10 10">
              <rect x="2" y="0" width="8" height="8" fill="var(--bg2)" stroke="currentColor" strokeWidth="1"/>
              <rect x="0" y="2" width="8" height="8" fill="var(--bg2)" stroke="currentColor" strokeWidth="1"/>
            </svg>
          ) : (
            <svg width="10" height="10" viewBox="0 0 10 10">
              <rect x="0.5" y="0.5" width="9" height="9" fill="none" stroke="currentColor" strokeWidth="1"/>
            </svg>
          )}
        </button>
        <button className="titlebar-btn close" onClick={() => win.close()} title="Close">
          <svg width="10" height="10" viewBox="0 0 10 10">
            <line x1="0.5" y1="0.5" x2="9.5" y2="9.5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round"/>
            <line x1="9.5" y1="0.5" x2="0.5" y2="9.5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round"/>
          </svg>
        </button>
      </div>
    </div>
  );
}
