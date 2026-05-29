import { useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { openUrl } from '@tauri-apps/plugin-opener';

export default function UpdatesView({ config, onTabChange }) {
  const [statuses, setStatuses] = useState(null);
  const [loading, setLoading]   = useState(false);
  const [error, setError]       = useState(null);

  const hasApiKey = !!config?.nexusApiKey;

  async function checkUpdates() {
    setLoading(true);
    setError(null);
    try {
      const results = await invoke('check_mod_updates');
      setStatuses(results);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }

  const withUpdates = statuses?.filter(s => s.hasUpdate) ?? [];
  const upToDate    = statuses?.filter(s => !s.hasUpdate) ?? [];

  return (
    <>
      <div className="pane-header">
        <span className="pane-title">Updates</span>
        {hasApiKey && (
          <button className="btn-ghost sm" onClick={checkUpdates} disabled={loading}>
            {loading ? 'Checking…' : statuses !== null ? 'Re-check' : 'Check for Updates'}
          </button>
        )}
      </div>

      <div className="pane-scroll">
        {!hasApiKey ? (
          <div className="nexus-prompt">
            <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" style={{color:'var(--text3)'}}>
              <rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>
            </svg>
            <p>Add your Nexus API key in Settings to check for mod updates.</p>
            <button className="btn-primary sm" onClick={() => onTabChange('settings')}>Open Settings</button>
          </div>

        ) : statuses === null && !loading ? (
          <div className="empty-state">
            <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" style={{color:'var(--text3)'}}>
              <polyline points="23 4 23 10 17 10"/>
              <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/>
            </svg>
            <p>Check if any of your installed Nexus mods have newer versions available.</p>
            <button className="btn-primary sm" onClick={checkUpdates}>Check for Updates</button>
          </div>

        ) : loading ? (
          <div className="empty-state">
            <div className="updates-spinner" />
            <p style={{color:'var(--text3)'}}>Checking mod versions…</p>
          </div>

        ) : error ? (
          <div className="empty-state" style={{color:'var(--error)'}}><p>{error}</p></div>

        ) : withUpdates.length === 0 ? (
          <div className="empty-state">
            <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="var(--success)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="20 6 9 17 4 12"/>
            </svg>
            <p>All {statuses.length} tracked mod{statuses.length !== 1 ? 's' : ''} are up to date.</p>
            {statuses.length === 0 && (
              <p style={{fontSize:'12px', color:'var(--text3)', maxWidth:'300px', textAlign:'center'}}>
                Install mods via Mod Manager Download or the Discover tab to start tracking updates.
              </p>
            )}
          </div>

        ) : (
          <div className="updates-list">
            <div className="updates-section-label">
              {withUpdates.length} update{withUpdates.length !== 1 ? 's' : ''} available
            </div>

            {withUpdates.map(s => (
              <div key={s.modPath} className="update-row">
                <span className="update-mod-name">{s.modName}</span>
                <div className="update-versions">
                  <span className="update-v-cur">{s.installedVersion ?? '?'}</span>
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{color:'var(--text3)', flexShrink:0}}>
                    <line x1="5" y1="12" x2="19" y2="12"/><polyline points="12 5 19 12 12 19"/>
                  </svg>
                  <span className="update-v-new">{s.latestVersion ?? '?'}</span>
                </div>
                <button
                  className="btn-ghost sm"
                  onClick={() => s.modId && openUrl(`https://www.nexusmods.com/subnautica2/mods/${s.modId}?tab=files`)}
                  disabled={!s.modId}
                >
                  Open Files Page
                </button>
              </div>
            ))}

            {upToDate.length > 0 && (
              <p className="updates-up-to-date">
                {upToDate.length} mod{upToDate.length !== 1 ? 's' : ''} up to date
              </p>
            )}
          </div>
        )}
      </div>
    </>
  );
}
