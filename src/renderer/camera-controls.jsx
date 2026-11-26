import React, { useEffect, useState } from 'react';

// Shooting settings for a Sony camera tethered through Sony's SDK: aperture,
// shutter, ISO, exposure comp, white balance, focus, drive and bracketing.
// The camera is the source of truth: the app asks it to change a setting
// and shows whatever the camera reports back.

const api = window.tether;
const STEPPED = new Set(['fnumber', 'shutter', 'iso', 'ev', 'kelvin']);
// Clicking these mustn't leave them focused, or the Space bar (shoot) would
// press them again.
const noFocus = (e) => e.preventDefault();

function Control({ control, onSet }) {
  const { key, label, value, display, options, writable } = control;
  const i = options.findIndex((o) => o.value === value);
  const step = (d) => {
    const next = options[i + d];
    if (next) onSet(key, next.value);
  };
  if (!writable) {
    return (
      <div className="cam-row">
        <span className="cam-label">{label}</span>
        <div className="cam-fixed" title="Change this on the camera">
          <span className="cam-value">{display}</span>
          <span className="muted small">on camera</span>
        </div>
      </div>
    );
  }
  const groups = [];
  for (const o of options) {
    const g = groups.find((x) => x.name === o.group);
    if (g) g.options.push(o); else groups.push({ name: o.group, options: [o] });
  }
  const select = (
    <select className="cam-select" value={value} onChange={(e) => { onSet(key, Number(e.target.value)); e.target.blur(); }} aria-label={label}>
      {groups.map((g) => (g.name ? (
        <optgroup key={g.name} label={g.name}>
          {g.options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        </optgroup>
      ) : g.options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)))}
    </select>
  );
  return (
    <div className="cam-row">
      <span className="cam-label">{label}</span>
      {STEPPED.has(key) ? (
        <div className="cam-stepper">
          <button type="button" className="cam-step" disabled={i <= 0} onMouseDown={noFocus} onClick={() => step(-1)} aria-label={`${label} down`}>◀</button>
          {select}
          <button type="button" className="cam-step" disabled={i < 0 || i >= options.length - 1} onMouseDown={noFocus} onClick={() => step(1)} aria-label={`${label} up`}>▶</button>
        </div>
      ) : select}
    </div>
  );
}

function shotNote(plan) {
  if (!plan || (plan.holdMs <= 35 && plan.count <= 1)) return null;
  if (plan.count > 1) return `Shoot takes all ${plan.count} bracket frames, one press each.`;
  return 'Shoot holds the button down until the whole bracket is taken.';
}

export function CameraControls({ sony, onError }) {
  const [settings, setSettings] = useState(null);

  useEffect(() => {
    const off = api.onSonySettings(setSettings);
    api.sonySettings().then(setSettings).catch(() => {});
    return off;
  }, []);

  if (!sony || sony.status !== 'connected' || !settings || !settings.controls.length) return null;
  const set = (key, value) => api.sonySet(key, value).catch(onError);
  const note = shotNote(settings.plan);
  const { battery, shotsLeft } = settings.info;
  return (
    <section className="panel-section camera-controls">
      <h3>
        <span>Camera</span>
        <span className="cam-info">
          {battery && <span title="Camera battery">Battery {battery}</span>}
          {shotsLeft && <span title="Frames left on the camera's card">Card {shotsLeft}</span>}
        </span>
      </h3>
      {settings.controls.map((c) => <Control key={c.key} control={c} onSet={set} />)}
      <button type="button" className="primary big cam-shoot" title="Take a picture (Space)" onMouseDown={noFocus} onClick={() => api.sonyShoot().catch(onError)}>Shoot</button>
      {note && <p className="muted small cam-note">{note}</p>}
    </section>
  );
}
