'use strict';

/**
 * Création d'éléments DOM sans innerHTML pour les données utilisateur
 * (les chaînes passées en enfants sont toujours insérées comme texte).
 *   h('div', { class: 'x', onclick: fn }, 'texte', h('span', null, '…'))
 * L'attribut spécial `html` n'est utilisé que pour des icônes internes.
 */
function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  if (attrs) {
    for (const [key, value] of Object.entries(attrs)) {
      if (value == null || value === false) continue;
      if (key === 'class') el.className = value;
      else if (key === 'html') el.innerHTML = value;
      else if (key === 'style' && typeof value === 'object') Object.assign(el.style, value);
      else if (key === 'dataset') Object.assign(el.dataset, value);
      else if (key.startsWith('on') && typeof value === 'function') el.addEventListener(key.slice(2).toLowerCase(), value);
      else if (key === 'value') el.value = value;
      else if (value === true) el.setAttribute(key, '');
      else el.setAttribute(key, String(value));
    }
  }
  appendChildren(el, children);
  return el;
}

function appendChildren(el, children) {
  for (const child of children.flat(Infinity)) {
    if (child == null || child === false) continue;
    el.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
}

function iconEl(name, extraClass) {
  const span = document.createElement('span');
  span.innerHTML = icon(name, extraClass);
  return span.firstElementChild;
}

function clear(el) {
  while (el.firstChild) el.removeChild(el.firstChild);
  return el;
}

const RTF = new Intl.RelativeTimeFormat('fr', { numeric: 'auto' });
const DTF = new Intl.DateTimeFormat('fr-FR', { dateStyle: 'medium', timeStyle: 'short' });
const TF = new Intl.DateTimeFormat('fr-FR', { hour: '2-digit', minute: '2-digit', second: '2-digit' });

function formatRelative(ts) {
  if (!ts) return '—';
  const diff = (ts - Date.now()) / 1000;
  const abs = Math.abs(diff);
  const units = [
    ['year', 31536000], ['month', 2592000], ['week', 604800],
    ['day', 86400], ['hour', 3600], ['minute', 60],
  ];
  for (const [unit, secs] of units) {
    if (abs >= secs) return RTF.format(Math.round(diff / secs), unit);
  }
  return "à l'instant";
}

function formatDate(ts) { return ts ? DTF.format(new Date(ts)) : '—'; }
function formatTime(ts) { return TF.format(new Date(ts)); }

function formatDuration(ms) {
  if (ms == null) return '';
  if (ms < 1000) return `${ms} ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)} s`;
  const m = Math.floor(s / 60);
  return `${m} min ${Math.round(s % 60)} s`;
}

function initials(name) {
  const parts = String(name || '?').trim().split(/[\s._-]+/).filter(Boolean);
  if (!parts.length) return '?';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[1][0]).toUpperCase();
}

const AVATAR_COLORS = ['#6b4fbb', '#1f75cb', '#108548', '#c17d10', '#dd2b0e', '#a53a8b', '#2e7d8c', '#5c6bc0'];
function colorFor(text) {
  let hash = 0;
  for (const ch of String(text)) hash = (hash * 31 + ch.charCodeAt(0)) | 0;
  return AVATAR_COLORS[Math.abs(hash) % AVATAR_COLORS.length];
}

/** Met en évidence (sans innerHTML) les occurrences d'une recherche insensible à la casse. */
function highlight(text, query) {
  if (!query) return [text];
  const lower = text.toLowerCase();
  const q = query.toLowerCase();
  const out = [];
  let i = 0;
  let idx;
  while ((idx = lower.indexOf(q, i)) !== -1) {
    if (idx > i) out.push(text.slice(i, idx));
    out.push(h('mark', null, text.slice(idx, idx + q.length)));
    i = idx + q.length;
  }
  if (i < text.length) out.push(text.slice(i));
  return out;
}

function debounce(fn, ms) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

const prefs = {
  get(key, fallback) {
    try {
      const v = localStorage.getItem(`gitpilot:${key}`);
      return v == null ? fallback : JSON.parse(v);
    } catch {
      return fallback;
    }
  },
  set(key, value) {
    try { localStorage.setItem(`gitpilot:${key}`, JSON.stringify(value)); } catch { /* ignore */ }
  },
};
