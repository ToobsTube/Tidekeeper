import { useState, useEffect, useRef, useDeferredValue } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { openUrl } from '@tauri-apps/plugin-opener';
// invoke is used by InstallModal for install_nexus_mod (future)

function fmtNum(n) {
  if (!n) return '0';
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
  if (n >= 1_000)     return (n / 1_000).toFixed(1) + 'k';
  return String(n);
}

function Skeletons() {
  return (
    <div className="skeleton-grid">
      {Array.from({ length: 12 }).map((_, i) => (
        <div key={i} className="skeleton-card">
          <div className="skeleton-img" />
          <div className="skeleton-body">
            <div className="skeleton-line" />
            <div className="skeleton-line short" />
            <div className="skeleton-line" />
          </div>
        </div>
      ))}
    </div>
  );
}

function DetailModal({ mod, onClose, onInstall }) {
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal modal-wide" onClick={e => e.stopPropagation()}>
        {mod.pictureUrl && (
          <img
            src={mod.pictureUrl} alt=""
            style={{ width:'100%', height:'180px', objectFit:'cover', borderRadius:'10px 10px 0 0', display:'block', flexShrink:0 }}
            onError={e => { e.target.style.display = 'none'; }}
          />
        )}
        <div style={{ padding:'20px', display:'flex', flexDirection:'column', gap:'10px' }}>
          <div style={{ display:'flex', alignItems:'flex-start', justifyContent:'space-between', gap:'8px' }}>
            <div>
              <div className="modal-title">{mod.name}</div>
              <div style={{ fontSize:'12px', color:'var(--text3)', marginTop:'2px' }}>{mod.author}</div>
            </div>
            <button className="modal-close" onClick={onClose}>✕</button>
          </div>
          <div style={{ display:'flex', gap:'16px', fontSize:'11px', color:'var(--text3)' }}>
            <span>⬇ {fmtNum(mod.downloadCount)} downloads</span>
            <span>♥ {fmtNum(mod.endorsementCount)} endorsements</span>
          </div>
          {mod.summary && (
            <p style={{ fontSize:'13px', color:'var(--text2)', lineHeight:'1.6', margin:0 }}>
              {mod.summary}
            </p>
          )}
          <div style={{ display:'flex', gap:'8px', justifyContent:'flex-end', marginTop:'4px' }}>
            <button className="btn-ghost sm" onClick={() => openUrl(`https://www.nexusmods.com/subnautica2/mods/${mod.modId}`)}>
              Open on Nexus
            </button>
            <button className="btn-install" onClick={() => { onClose(); onInstall(mod); }}>
              Install
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function NonPremiumModal({ mod, onClose }) {
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={e => e.stopPropagation()}>
        <div className="modal-header">
          <span className="modal-title">{mod.name}</span>
          <button className="modal-close" onClick={onClose}>✕</button>
        </div>
        <p style={{fontSize:'13px', color:'var(--text2)', lineHeight:'1.6', margin:'4px 0 16px'}}>
          Direct install requires Nexus Premium. On the files page, click{' '}
          <strong style={{color:'var(--text)'}}>Mod Manager Download</strong> and Tidekeeper
          will handle the rest automatically.
        </p>
        <div style={{display:'flex', gap:'8px', justifyContent:'flex-end'}}>
          <button className="btn-ghost sm" onClick={onClose}>Cancel</button>
          <button className="btn-primary sm" onClick={() => {
            openUrl(`https://www.nexusmods.com/subnautica2/mods/${mod.modId}?tab=files`);
            onClose();
          }}>
            Open Files Page
          </button>
        </div>
      </div>
    </div>
  );
}

function InstallModal({ mod, onClose, onInstalled }) {
  const [files, setFiles]     = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState(null);
  const [installing, setInstalling] = useState(null);
  const [done, setDone]       = useState(null);

  useEffect(() => {
    invoke('get_nexus_mod_files', { modId: mod.modId })
      .then(setFiles)
      .catch(e => setError(String(e)))
      .finally(() => setLoading(false));
  }, [mod.modId]);

  async function install(file) {
    setInstalling(file.fileId);
    setError(null);
    try {
      const name = await invoke('install_nexus_mod', { modId: mod.modId, fileId: file.fileId, version: file.version ?? null, fileName: file.name ?? null });
      setDone(name || file.name);
      onInstalled();
    } catch (e) {
      setError(String(e));
    } finally {
      setInstalling(null);
    }
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={e => e.stopPropagation()}>
        <div className="modal-header">
          <span className="modal-title">{mod.name}</span>
          <button className="modal-close" onClick={onClose}>✕</button>
        </div>
        <p className="modal-hint">Choose a file to install:</p>
        {done ? (
          <div className="modal-done">
            <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="var(--success)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="20 6 9 17 4 12"/>
            </svg>
            <p>Installed <strong>{done}</strong></p>
            <button className="btn-primary sm" onClick={onClose}>Done</button>
          </div>
        ) : loading ? (
          <p style={{color:'var(--text3)', padding:'16px 0'}}>Loading files…</p>
        ) : error ? (
          <p style={{color:'var(--error)', padding:'8px 0'}}>{error}</p>
        ) : !files?.length ? (
          <p style={{color:'var(--text3)'}}>No installable files found.</p>
        ) : (
          <div className="file-list">
            {files.map(f => (
              <div key={f.fileId} className="file-row">
                <div className="file-info">
                  <span className="file-name">{f.name}</span>
                  {f.version && <span className="file-version">v{f.version}</span>}
                  {f.sizeKb && <span className="file-size">{(f.sizeKb / 1024).toFixed(1)} MB</span>}
                </div>
                <button
                  className="btn-install"
                  disabled={installing === f.fileId}
                  onClick={() => install(f)}
                >
                  {installing === f.fileId ? 'Installing…' : 'Install'}
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

export default function DiscoverView({ config, onTabChange, isPremium }) {
  const [source, setSource]     = useState('nexus');
  const [category, setCategory] = useState('trending');
  const [nexusMods, setNexusMods] = useState(null);
  const [loading, setLoading]   = useState(false);
  const [error, setError]       = useState(null);
  const [search, setSearch]     = useState('');
  const [selected, setSelected]   = useState(null);
  const [detailMod, setDetailMod] = useState(null);
  const deferred = useDeferredValue(search);

  const hasApiKey = !!config?.nexusApiKey;

  const [offset, setOffset]       = useState(0);
  const [total, setTotal]         = useState(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const sentinelRef = useRef(null);
  const PAGE = 40;

  const sortField  = category === 'latest'  ? 'createdAt'
                   : category === 'updated' ? 'updatedAt'
                   : 'endorsements';
  const sortDir = 'DESC';

  const fetchMods = async (off, replace) => {
    if (replace) { setLoading(true); setError(null); setNexusMods(null); }
    else setLoadingMore(true);

    const query = `query {
      mods(
        filter: { gameDomainName: { value: "subnautica2" } }
        sort: [{ ${sortField}: { direction: ${sortDir} } }]
        count: ${PAGE}
        offset: ${off}
      ) {
        nodes {
          modId
          name
          summary
          pictureUrl
          uploader { name memberId }
          downloads
          endorsements
        }
        totalCount
      }
    }`;

    try {
      const r = await fetch('https://api.nexusmods.com/v2/graphql', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          apikey: config.nexusApiKey,
          'Application-Name': 'Tidekeeper',
          'Application-Version': '0.1.0',
        },
        body: JSON.stringify({ query }),
      });
      if (!r.ok) throw new Error(`Nexus API error: ${r.status}`);
      const json = await r.json();
      if (json.errors) throw new Error(json.errors[0]?.message ?? 'GraphQL error');
      const nodes = json.data?.mods?.nodes ?? [];
      const mapped = nodes.map(m => ({
        modId: m.modId,
        name: m.name,
        summary: m.summary,
        pictureUrl: m.pictureUrl,
        author: m.uploader?.name ?? '',
        downloadCount: m.downloads,
        endorsementCount: m.endorsements,
      }));
      setTotal(json.data?.mods?.totalCount ?? null);
      setNexusMods(prev => replace ? mapped : [...(prev ?? []), ...mapped]);
      setOffset(off + PAGE);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
      setLoadingMore(false);
    }
  };

  useEffect(() => {
    if (source !== 'nexus' || !hasApiKey) return;
    setOffset(0);
    setTotal(null);
    fetchMods(0, true);
  }, [source, category, hasApiKey]);

  // Infinite scroll: load next page when sentinel scrolls into view
  useEffect(() => {
    const el = sentinelRef.current;
    if (!el || loadingMore || loading || !nexusMods || total === null || nexusMods.length >= total || deferred) return;
    const observer = new IntersectionObserver(([entry]) => {
      if (entry.isIntersecting) fetchMods(offset, false);
    }, { threshold: 0 });
    observer.observe(el);
    return () => observer.disconnect();
  }, [offset, total, nexusMods?.length, loadingMore, loading, !!deferred]);

  const visible = nexusMods
    ? nexusMods.filter(m => {
        if (!deferred) return true;
        const q = deferred.toLowerCase();
        return m.name.toLowerCase().includes(q) || m.author.toLowerCase().includes(q);
      })
    : [];

  return (
    <>
      <div className="pane-header">
        <div className="source-toggle">
          <button className={`source-btn${source === 'nexus' ? ' active' : ''}`} onClick={() => setSource('nexus')}>
            Nexus Mods
          </button>
          <button className={`source-btn${source === 'thunderstore' ? ' active' : ''}`} onClick={() => setSource('thunderstore')}>
            Thunderstore
          </button>
        </div>

        {source === 'nexus' && hasApiKey && (
          <>
            <div className="cat-toggle">
              {['trending','latest','updated'].map(c => (
                <button key={c} className={`source-btn sm${category === c ? ' active' : ''}`} onClick={() => setCategory(c)}>
                  {c === 'trending' ? 'Trending' : c === 'latest' ? 'New' : 'Updated'}
                </button>
              ))}
            </div>
            <div className="search-wrap">
              <svg className="search-icon" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>
              </svg>
              <input className="search-input" placeholder="Search mods…" value={search} onChange={e => setSearch(e.target.value)} autoComplete="off" />
            </div>
          </>
        )}
      </div>

      <div className="pane-scroll">
        {source === 'thunderstore' ? (
          <div className="nexus-prompt">
            <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" style={{color:'var(--text3)'}}>
              <circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/>
            </svg>
            <p>Thunderstore doesn't have a Subnautica 2 community yet.<br/>Check back after the game launches fully.</p>
          </div>
        ) : !hasApiKey ? (
          <div className="nexus-prompt">
            <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" style={{color:'var(--text3)'}}>
              <rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>
            </svg>
            <p>Add your Nexus API key in Settings to browse and install mods.</p>
            <button className="btn-primary sm" onClick={() => onTabChange('settings')}>Open Settings</button>
          </div>
        ) : loading ? (
          <Skeletons />
        ) : error ? (
          <div className="empty-state" style={{color:'var(--error)'}}><p>{error}</p></div>
        ) : visible.length === 0 ? (
          <div className="empty-state"><p>No mods match "{search}".</p></div>
        ) : (
          <>
        <div className="mods-grid">
            {visible.map(mod => (
              <div key={mod.modId} className="mod-card" style={{cursor:'pointer'}} onClick={() => setDetailMod(mod)}>
                {mod.pictureUrl
                  ? <img className="mod-card-img" src={mod.pictureUrl} alt="" loading="lazy" onError={e => { e.target.style.display='none'; }} />
                  : <div className="mod-card-placeholder">◈</div>
                }
                <div className="mod-card-body">
                  <div className="mod-card-name" title={mod.name}>{mod.name}</div>
                  <div className="mod-card-author">{mod.author}</div>
                  <div className="mod-card-desc">{mod.summary}</div>
                </div>
                <div className="mod-card-footer">
                  <span className="mod-card-dl">
                    <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
                      <polyline points="7 10 12 15 17 10"/>
                      <line x1="12" y1="15" x2="12" y2="3"/>
                    </svg>
                    {fmtNum(mod.downloadCount)}
                  </span>
                  <button className="btn-ghost xs" onClick={e => { e.stopPropagation(); openUrl(`https://www.nexusmods.com/subnautica2/mods/${mod.modId}`); }}>
                    <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>
                      <polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/>
                    </svg>
                    Nexus
                  </button>
                  <button className="btn-install" onClick={e => { e.stopPropagation(); setSelected(mod); }}>Install</button>
                </div>
              </div>
            ))}
          </div>
        <div ref={sentinelRef} style={{height:'48px', display:'flex', alignItems:'center', justifyContent:'center'}}>
          {loadingMore && <span style={{fontSize:'12px', color:'var(--text3)'}}>Loading more…</span>}
        </div>
        </>
        )}
      </div>

      {detailMod && (
        <DetailModal
          mod={detailMod}
          onClose={() => setDetailMod(null)}
          onInstall={mod => setSelected(mod)}
        />
      )}

      {selected && isPremium && (
        <InstallModal
          mod={selected}
          onClose={() => setSelected(null)}
          onInstalled={() => {}}
        />
      )}

      {selected && !isPremium && (
        <NonPremiumModal mod={selected} onClose={() => setSelected(null)} />
      )}
    </>
  );
}
