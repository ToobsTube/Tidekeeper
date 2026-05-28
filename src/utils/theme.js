export const PRESETS = [
  { id: 'ocean',  label: 'Ocean',  accent: '#00d4ff' },
  { id: 'ember',  label: 'Ember',  accent: '#ff7043' },
  { id: 'forest', label: 'Forest', accent: '#26d98c' },
  { id: 'violet', label: 'Violet', accent: '#9d71f5' },
  { id: 'rose',   label: 'Rose',   accent: '#f06292' },
];

function hexToRgb(hex) {
  const h = hex.replace('#', '');
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  return `${r},${g},${b}`;
}

export function applyTheme(accent) {
  const rgb = hexToRgb(accent);
  const root = document.documentElement;
  root.style.setProperty('--accent',       accent);
  root.style.setProperty('--accent-dim',   `rgba(${rgb},0.1)`);
  root.style.setProperty('--accent-hover', `rgba(${rgb},0.18)`);
  root.style.setProperty('--accent-glow',  `rgba(${rgb},0.22)`);
}

export function loadTheme() {
  const saved = localStorage.getItem('tk-accent') ?? '#00d4ff';
  applyTheme(saved);
}

export function saveTheme(accent) {
  localStorage.setItem('tk-accent', accent);
  applyTheme(accent);
}
