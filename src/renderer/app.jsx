import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';

const api = window.tether;
const LABELS = ['red', 'yellow', 'green', 'blue', 'purple'];
const LABEL_KEYS = { 6: 'red', 7: 'yellow', 8: 'green', 9: 'blue' };
const img = (p) => (p ? 'tether://p' + p.split('/').map(encodeURIComponent).join('/') : null);
const today = () => new Date().toLocaleDateString('en-CA');
const gb = (b) => (b / 1024 ** 3).toFixed(b > 100 * 1024 ** 3 ? 0 : 1) + ' GB';

// ---------------------------------------------------------------- setup

function Field({ label, hint, children }) {
  return (
    <label className="field">
      <span className="field-label">{label}</span>
      {children}
      {hint && <span className="field-hint">{hint}</span>}
    </label>
  );
}

function FolderPicker({ label, value, onChange, title }) {
  return (
    <Field label={label}>
      <div className="folder-pick">
        <span className={value ? 'path' : 'path empty'} title={value}>{value ? <bdi>{value}</bdi> : 'Not chosen'}</span>
        <button type="button" onClick={async () => { const p = await api.pickFolder(title); if (p) onChange(p); }}>Choose…</button>
      </div>
    </Field>
  );
}

function Setup({ onOpen }) {
  const [defaults, setDefaults] = useState(null);
  const [sessions, setSessions] = useState([]);
  const [form, setForm] = useState({
    client: '', job: '', jobNumber: '', date: today(), dateFormat: 'YYYY-MM-DD',
    fileTemplate: '', folderTemplate: '', startSequence: 1,
    sourceDir: '', destinations: ['', ''], locationsText: '', labels: {},
  });
  const [example, setExample] = useState(null);
  const [error, setError] = useState(null);
  const [advanced, setAdvanced] = useState(false);

  useEffect(() => {
    api.defaults().then((d) => {
      setDefaults(d);
      setForm((f) => ({ ...f, fileTemplate: d.fileTemplate, folderTemplate: d.folderTemplate, labels: d.labels }));
    });
    api.sessions().then(setSessions);
  }, []);

  const input = useMemo(() => ({
    ...form,
    locations: form.locationsText.split(/[\n,]/).map((s) => s.trim()).filter(Boolean),
    destinations: form.destinations.filter(Boolean),
  }), [form]);

  useEffect(() => {
    if (!defaults) return;
    api.previewName(input).then(setExample).catch(() => setExample(null));
  }, [input, defaults]);

  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target ? e.target.value : e }));
  const setDest = (i) => (p) => setForm((f) => { const d = [...f.destinations]; d[i] = p; return { ...f, destinations: d }; });

  const submit = async (e) => {
    e.preventDefault();
    setError(null);
    try {
      const id = await api.createSession(input);
      onOpen(id);
    } catch (err) {
      setError(err.message);
    }
  };

  if (!defaults) return null;
  return (
    <div className="setup">
      <form className="setup-form" onSubmit={submit}>
        <h1>New session</h1>
        <div className="row">
          <Field label="Client"><input autoFocus value={form.client} onChange={set('client')} placeholder="Dun Diggin" /></Field>
          <Field label="Job"><input value={form.job} onChange={set('job')} placeholder="Fall Campaign" /></Field>
          <Field label="Job number"><input value={form.jobNumber} onChange={set('jobNumber')} /></Field>
        </div>
        <div className="row">
          <Field label="Shoot date"><input type="date" value={form.date} onChange={set('date')} /></Field>
          <Field label="Date in file names">
            <select value={form.dateFormat} onChange={set('dateFormat')}>
              {defaults.dateFormats.map((d) => <option key={d}>{d}</option>)}
            </select>
          </Field>
        </div>
        <Field label="Locations" hint="One per line or comma separated. Each becomes a folder, and its name goes into every file shot there. You can add more during the shoot.">
          <textarea rows={3} value={form.locationsText} onChange={set('locationsText')} placeholder={'Main Salon\nLobby\nSuite 401'} />
        </Field>

        <h2>Where files come from and go</h2>
        <FolderPicker label="Watched folder (camera card or tether drop folder)" value={form.sourceDir} onChange={set('sourceDir')} title="Folder to watch for incoming RAWs" />
        {form.destinations.map((d, i) => (
          <FolderPicker key={i} label={i === 0 ? 'Main destination' : `Backup ${i}`} value={d} onChange={setDest(i)} title={i === 0 ? 'Main destination' : 'Backup destination'} />
        ))}
        <button type="button" className="link" onClick={() => setForm((f) => ({ ...f, destinations: [...f.destinations, ''] }))}>+ Add another backup</button>

        <button type="button" className="link" onClick={() => setAdvanced(!advanced)}>{advanced ? '▾' : '▸'} Naming and Bridge labels</button>
        {advanced && (
          <div className="advanced">
            <Field label="File name" hint="{client} {job} {jobnumber} {date} {location} {sequence} {sequence:N} {ext}">
              <input value={form.fileTemplate} onChange={set('fileTemplate')} className="mono" />
            </Field>
            <Field label="Folders"><input value={form.folderTemplate} onChange={set('folderTemplate')} className="mono" /></Field>
            <Field label="Start counting at"><input type="number" min="1" value={form.startSequence} onChange={set('startSequence')} /></Field>
            <p className="field-hint">Color label names must match Bridge › Settings › Labels exactly, or Bridge shows a white label.</p>
            <div className="row labels">
              {LABELS.map((c) => (
                <Field key={c} label={<><span className={`swatch ${c}`} /> {c}</>}>
                  <input value={form.labels[c] || ''} onChange={(e) => setForm((f) => ({ ...f, labels: { ...f.labels, [c]: e.target.value } }))} />
                </Field>
              ))}
            </div>
          </div>
        )}

        <div className="example">
          <span className="field-label">First file will be</span>
          {example?.error ? <span className="bad">{example.error}</span> : <code>{example?.relPath}</code>}
        </div>
        {error && <pre className="form-error">{error}</pre>}
        <button className="primary big" type="submit">Start session</button>
      </form>

      {sessions.length > 0 && (
        <aside className="recent">
          <h2>Recent sessions</h2>
          {sessions.map((s) => (
            <button key={s.id} className="recent-item" onClick={() => onOpen(s.id)}>
              <strong>{s.client}</strong> {s.job && <span>· {s.job}</span>}
              <span className="muted">{s.date} · {s.assetCount} frames</span>
            </button>
          ))}
        </aside>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- status

function StatusBar({ session, stats, onRetryAll, onClose }) {
  const badHealth = stats.health.filter((h) => !h.ok);
  const lowSpace = stats.health.filter((h) => h.ok && h.lowSpace);
  let state = 'ok';
  let text = stats.total ? `All safe · ${stats.backedUp} frames on every drive` : 'Waiting for the first frame';
  if (stats.ingesting) { state = 'busy'; text = `Copying · ${stats.ingesting} in progress`; }
  if (lowSpace.length) { state = 'warn'; text = `Low space on ${lowSpace.map((h) => h.label).join(', ')}`; }
  if (stats.errors || badHealth.length) {
    state = 'error';
    const parts = [];
    if (badHealth.length) parts.push(badHealth.map((h) => `${h.label} ${h.error.toLowerCase()}`).join(' · '));
    if (stats.errors) parts.push(`${stats.errors} frame${stats.errors > 1 ? 's' : ''} not safely backed up`);
    text = parts.join(' · ');
  }
  return (
    <header className={`status status-${state}`}>
      <button className="ghost" onClick={onClose} title="Back to sessions">‹</button>
      <div className="status-session">
        <strong>{session.client}</strong> {session.job && <span>· {session.job}</span>}
        <span className="muted"> · {session.date}</span>
      </div>
      <div className="status-text">{text}</div>
      {stats.errors > 0 && <button className="danger" onClick={onRetryAll}>Retry failed copies</button>}
      <div className="drives">
        {stats.health.map((h) => (
          <span key={h.dir} className={`drive ${h.ok ? (h.lowSpace ? 'warn' : 'ok') : 'bad'}`} title={h.dir}>
            {h.label} {h.ok ? (h.label === 'Watched folder' ? '' : gb(h.freeBytes)) : '✕'}
          </span>
        ))}
      </div>
    </header>
  );
}

// ---------------------------------------------------------------- left panel

function Histogram({ data }) {
  const ref = useRef();
  useEffect(() => {
    const c = ref.current;
    const ctx = c.getContext('2d');
    const w = c.width, h = c.height;
    ctx.clearRect(0, 0, w, h);
    if (!data) return;
    const max = Math.max(...['r', 'g', 'b'].flatMap((k) => data.bins[k].slice(2, 254))) || 1;
    ctx.globalCompositeOperation = 'lighter';
    for (const [k, color] of [['r', '#e5484d'], ['g', '#46a758'], ['b', '#3e63dd']]) {
      ctx.fillStyle = color;
      data.bins[k].forEach((v, i) => {
        const bh = Math.min(h, (v / max) * h);
        ctx.fillRect((i / 256) * w, h - bh, w / 256 + 0.5, bh);
      });
    }
  }, [data]);
  return <canvas ref={ref} width={512} height={160} className="histogram" />;
}

function ToneTools({ asset, analysis, showClip, setShowClip }) {
  const hi = analysis?.highlightClipPct ?? 0;
  const lo = analysis?.shadowClipPct ?? 0;
  return (
    <section className="panel-section">
      <h3>Tone</h3>
      <Histogram data={analysis} />
      {asset && analysis && (
        <div className="clip-stats">
          <div className={hi > 0.5 ? 'clip warn' : 'clip'}><span>Highlights clipped</span><strong>{hi.toFixed(1)}%</strong></div>
          <div className={lo > 0.5 ? 'clip warn' : 'clip'}><span>Shadows clipped</span><strong>{lo.toFixed(1)}%</strong></div>
        </div>
      )}
      <label className="toggle"><input type="checkbox" checked={showClip} onChange={(e) => setShowClip(e.target.checked)} /> Show clipping on image (C)</label>
      <p className="muted small">Measured on the camera's embedded JPEG, which clips slightly before the RAW. A warning means "check this frame."</p>
    </section>
  );
}

function Dashboard({ stats }) {
  return (
    <section className="panel-section">
      <h3>Session</h3>
      <div className="tiles">
        <div className="tile"><strong>{stats.total}</strong><span>frames</span></div>
        <div className="tile"><strong>{stats.backedUp}</strong><span>backed up</span></div>
        <div className={`tile ${stats.errors ? 'bad' : ''}`}><strong>{stats.errors}</strong><span>problems</span></div>
        <div className="tile"><strong>{stats.perMinute}</strong><span>per min</span></div>
      </div>
    </section>
  );
}

function EventLog({ events, onClear }) {
  return (
    <section className="panel-section events">
      <h3>Log <button className="link small" onClick={onClear}>Clear</button></h3>
      <ul>
        {events.map((e) => (
          <li key={e.id} className={`event ${e.level}`}><span className="muted">{e.createdAt.slice(11, 16)}</span> {e.message}</li>
        ))}
      </ul>
    </section>
  );
}

// ---------------------------------------------------------------- center

function Stars({ rating, onSet }) {
  return (
    <span className={`stars ${rating ? 'set' : ''}`}>
      {[1, 2, 3].map((n) => (
        <button key={n} className={n <= rating ? 'on' : ''} onClick={(e) => { e.stopPropagation(); onSet(n === rating ? 0 : n); }}>★</button>
      ))}
    </span>
  );
}

const STATUS_TEXT = { ingesting: 'Copying', verified: 'Verified', backed_up: 'Backed up', error: 'Problem' };

function Thumb({ asset, selected, onSelect, onOpen, onReview }) {
  return (
    <div className={`thumb ${selected ? 'selected' : ''} label-${asset.label || 'none'}`} onClick={onSelect} onDoubleClick={onOpen}>
      <div className="thumb-img">
        {asset.thumbPath ? <img src={img(asset.thumbPath)} loading="lazy" /> : <div className="placeholder">{asset.status === 'error' ? '!' : '…'}</div>}
        <span className={`badge ${asset.status}`}>{STATUS_TEXT[asset.status]}</span>
      </div>
      <div className="thumb-meta">
        <span className="name" title={`${asset.fileName} (camera: ${asset.originalName})`}><bdi>{asset.fileName}</bdi></span>
        <Stars rating={asset.rating} onSet={(r) => onReview({ rating: r })} />
      </div>
    </div>
  );
}

function Viewer({ asset, showClip, compareWith, onClose }) {
  const [zoom, setZoom] = useState(false);
  const [mask, setMask] = useState(null);
  useEffect(() => { setZoom(false); }, [asset?.id]);
  useEffect(() => {
    setMask(null);
    if (showClip && asset) api.clipMask(asset.id).then(setMask).catch(() => {});
  }, [asset?.id, showClip]);
  if (!asset) return null;
  const frame = (a, m) => (
    <div className={`viewer-frame ${zoom ? 'zoomed' : ''}`} onClick={() => setZoom(!zoom)} key={a.id}>
      <div className="viewer-stack">
        <img src={img(a.previewPath)} />
        {m && <img className="clip-mask" src={m} />}
      </div>
      <div className="viewer-caption">{a.fileName} <span className="muted">· {a.originalName}</span></div>
    </div>
  );
  return (
    <div className={`viewer ${compareWith ? 'compare' : ''}`}>
      {compareWith && frame(compareWith, null)}
      {frame(asset, mask)}
      <button className="ghost viewer-close" onClick={onClose}>Grid (G)</button>
    </div>
  );
}

// ---------------------------------------------------------------- right panel

function Finder({ session, locations, viewing, setViewing, onAdd, onCapture }) {
  const [open, setOpen] = useState(true);
  const [name, setName] = useState('');
  const total = locations.reduce((n, l) => n + l.count, 0);
  return (
    <section className="panel-section finder">
      <h3>Locations</h3>
      <div className={`tree-row root ${viewing === null ? 'viewing' : ''}`} onClick={() => setViewing(null)}>
        <button className="chevron" onClick={(e) => { e.stopPropagation(); setOpen(!open); }}>{open ? '▾' : '▸'}</button>
        <span className="tree-name">{session.client}</span>
        <span className="count">{total}</span>
      </div>
      {open && locations.map((l) => (
        <div key={l.name} className={`tree-row child ${viewing === l.name ? 'viewing' : ''}`} onClick={() => setViewing(l.name)}>
          <button
            className={`capture-dot ${session.activeLocation === l.name ? 'active' : ''}`}
            title={session.activeLocation === l.name ? 'New frames go here' : 'Capture into this location'}
            onClick={(e) => { e.stopPropagation(); onCapture(l.name); }}
          />
          <span className="tree-name">{l.name}</span>
          <span className="count">{l.count}</span>
        </div>
      ))}
      <form className="add-location" onSubmit={(e) => { e.preventDefault(); if (name.trim()) { onAdd(name); setName(''); } }}>
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="New location…" />
        <button type="submit">Add</button>
      </form>
      <div className="capturing">
        <span className="muted">Capturing into</span>
        <strong>{session.activeLocation}</strong>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------- session

function SessionView({ id, onClose }) {
  const [session, setSession] = useState(null);
  const [assets, setAssets] = useState([]);
  const [stats, setStats] = useState(null);
  const [locations, setLocations] = useState([]);
  const [viewing, setViewing] = useState(null);
  const [selectedId, setSelectedId] = useState(null);
  const [mode, setMode] = useState('grid');
  const [compareId, setCompareId] = useState(null);
  const [analysis, setAnalysis] = useState(null);
  const [showClip, setShowClip] = useState(false);
  const [follow, setFollow] = useState(true);
  const [toast, setToast] = useState(null);

  const fail = (err) => setToast(err.message || String(err));

  useEffect(() => {
    let alive = true;
    api.openSession(id).then((r) => {
      if (!alive) return;
      setSession(r.session); setAssets(r.assets); setStats(r.stats); setLocations(r.locations);
    }).catch(fail);
    const offs = [
      api.onAsset((a) => setAssets((list) => {
        const i = list.findIndex((x) => x.id === a.id);
        if (i === -1) return [...list, a];
        const next = [...list]; next[i] = a; return next;
      })),
      api.onStats(({ stats: s, locations: l }) => { setStats(s); setLocations(l); }),
      api.onSession(setSession),
    ];
    return () => { alive = false; offs.forEach((off) => off()); api.closeSession(); };
  }, [id]);

  const visible = useMemo(() => (viewing ? assets.filter((a) => a.location === viewing) : assets), [assets, viewing]);
  const selected = assets.find((a) => a.id === selectedId) || null;

  // Follow new captures: when a frame finishes, select it (like live view in Capture One).
  const lastReady = useMemo(() => [...assets].reverse().find((a) => a.previewPath), [assets]);
  useEffect(() => {
    if (follow && lastReady && (!viewing || lastReady.location === viewing)) setSelectedId(lastReady.id);
  }, [lastReady?.id, follow]);

  useEffect(() => {
    setAnalysis(null);
    if (selected?.previewPath) api.analyze(selected.id).then(setAnalysis).catch(() => {});
  }, [selected?.id, selected?.previewPath]);

  const review = useCallback((assetId, r) => api.setReview(assetId, r).catch(fail), []);

  useEffect(() => {
    const onKey = (e) => {
      if (['INPUT', 'TEXTAREA', 'SELECT'].includes(e.target.tagName)) return;
      const i = visible.findIndex((a) => a.id === selectedId);
      if (e.key === 'ArrowRight' || e.key === 'ArrowDown') { e.preventDefault(); setFollow(false); const n = visible[Math.min(visible.length - 1, i + 1)]; if (n) setSelectedId(n.id); }
      else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') { e.preventDefault(); setFollow(false); const n = visible[Math.max(0, i - 1)]; if (n) setSelectedId(n.id); }
      else if (e.key === 'Enter' && selected) setMode(mode === 'grid' ? 'view' : 'grid');
      else if (e.key === 'g' || e.key === 'Escape') { setMode('grid'); setCompareId(null); }
      else if (e.key === 'c') setShowClip((s) => !s);
      else if (e.key === 'f') setFollow((f) => !f);
      else if (e.key === 'x' && selected) { setCompareId(compareId ? null : selected.id); setMode('view'); }
      else if (selected && /^[0-3]$/.test(e.key)) review(selected.id, { rating: Number(e.key) });
      else if (selected && LABEL_KEYS[e.key]) review(selected.id, { label: selected.label === LABEL_KEYS[e.key] ? null : LABEL_KEYS[e.key] });
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [visible, selectedId, selected, mode, compareId, review]);

  useEffect(() => { if (toast) { const t = setTimeout(() => setToast(null), 6000); return () => clearTimeout(t); } }, [toast]);

  if (!session || !stats) return <div className="loading">Opening session…</div>;
  const compareAsset = compareId && compareId !== selectedId ? assets.find((a) => a.id === compareId) : null;

  return (
    <div className="session">
      <StatusBar session={session} stats={stats} onRetryAll={() => api.retryAll().catch(fail)} onClose={onClose} />
      <div className="panels">
        <aside className="panel left">
          <ToneTools asset={selected} analysis={analysis} showClip={showClip} setShowClip={setShowClip} />
          <Dashboard stats={stats} />
          {selected && (
            <section className="panel-section">
              <h3>Frame</h3>
              <div className="frame-info">
                <div><span className="muted">Name</span> {selected.fileName}</div>
                <div><span className="muted">Camera name</span> {selected.originalName}</div>
                {selected.copies.map((c) => (
                  <div key={c.destinationId} className={c.status === 'verified' ? '' : 'bad'}>
                    <span className="muted">{c.role === 'primary' ? 'Main' : 'Backup'}</span> {c.status === 'verified' ? 'Checksum verified' : c.error || c.status}
                  </div>
                ))}
                <div className="label-picker">
                  {LABELS.map((c, i) => (
                    <button key={c} className={`swatch ${c} ${selected.label === c ? 'on' : ''}`} title={`${session.labels[c]}${i < 4 ? ` (${i + 6})` : ''}`}
                      onClick={() => review(selected.id, { label: selected.label === c ? null : c })} />
                  ))}
                </div>
                <div className="actions">
                  {selected.status === 'error' && <button className="danger" onClick={() => api.retry(selected.id).catch(fail)}>Retry</button>}
                  <button onClick={() => api.reveal(selected.id)}>Show in Finder</button>
                </div>
              </div>
            </section>
          )}
          <EventLog events={stats.lastEvents} onClear={() => api.clearEvents().catch(fail)} />
        </aside>

        <main className="panel center">
          {mode === 'view' && selected ? (
            <Viewer asset={selected} showClip={showClip} compareWith={compareAsset} onClose={() => { setMode('grid'); setCompareId(null); }} />
          ) : visible.length ? (
            <div className="grid">
              {visible.map((a) => (
                <Thumb key={a.id} asset={a} selected={a.id === selectedId}
                  onSelect={() => { setFollow(false); setSelectedId(a.id); }}
                  onOpen={() => { setSelectedId(a.id); setMode('view'); }}
                  onReview={(r) => review(a.id, r)} />
              ))}
            </div>
          ) : (
            <div className="empty-state">
              <p>Waiting for RAWs in</p>
              <code>{session.sourceDir}</code>
              <p className="muted">New frames are named into <strong>{session.activeLocation}</strong>.</p>
            </div>
          )}
          <div className="center-footer muted small">
            Enter view · ←→ move · 1–3 stars · 0 clear · 6–9 color label · X compare · C clipping · F follow new frames {follow ? '(on)' : '(off)'}
          </div>
        </main>

        <aside className="panel right">
          <Finder session={session} locations={locations} viewing={viewing} setViewing={setViewing}
            onAdd={(n) => api.addLocation(n).catch(fail)} onCapture={(n) => api.setActiveLocation(n).catch(fail)} />
        </aside>
      </div>
      {toast && <div className="toast" onClick={() => setToast(null)}>{toast}</div>}
    </div>
  );
}

function App() {
  const [sessionId, setSessionId] = useState(null);
  return sessionId ? <SessionView id={sessionId} onClose={() => setSessionId(null)} /> : <Setup onOpen={setSessionId} />;
}

createRoot(document.getElementById('root')).render(<App />);
