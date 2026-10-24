'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const SHELL_IDS = ['system', 'powershell', 'bash'];
const ACTION_SHELL_IDS = ['default', ...SHELL_IDS];

const LIMITS = {
  projectName: 100,
  actionName: 80,
  actionDescription: 300,
  script: 100_000,
};

const MAX_SCHEDULE_AHEAD_MS = 366 * 24 * 3600 * 1000;

class ValidationError extends Error {
  constructor(message) {
    super(message);
    this.userMessage = message;
  }
}

function samePath(a, b) {
  const na = path.resolve(a);
  const nb = path.resolve(b);
  return process.platform === 'win32' ? na.toLowerCase() === nb.toLowerCase() : na === nb;
}

/**
 * Persistance JSON simple dans le dossier userData.
 * Écriture atomique (fichier temporaire + rename) pour éviter toute corruption
 * en cas d'arrêt brutal de l'application.
 */
class Store {
  constructor(file, defaults) {
    this.file = file;
    this.defaultSettings = {
      defaultShell: 'system',
      timeoutMinutes: 15,
      fetchOnOpen: true,
      bashTrace: true,
      ssh: { enabled: false, identities: [] },
      ...defaults,
    };
    this.data = { version: 1, settings: { ...this.defaultSettings }, projects: [], schedules: [], accounts: [], activeAccounts: {} };
    this.load();
  }

  load() {
    let raw;
    try {
      raw = fs.readFileSync(this.file, 'utf8');
    } catch (err) {
      if (err.code !== 'ENOENT') console.error('[store] lecture impossible :', err);
      return;
    }
    try {
      const parsed = JSON.parse(raw);
      this.data = {
        version: 1,
        settings: this.sanitizeSettings({ ...this.defaultSettings, ...(parsed.settings || {}) }),
        projects: Array.isArray(parsed.projects) ? parsed.projects.filter((p) => p && p.id && p.path) : [],
        schedules: Array.isArray(parsed.schedules)
          ? parsed.schedules.filter((s) => s && s.id && s.projectId && s.actionId && Number.isFinite(s.runAt))
          : [],
        accounts: Array.isArray(parsed.accounts)
          ? parsed.accounts.filter((a) => a && typeof a.host === 'string' && (typeof a.secret === 'string' || typeof a.token === 'string'))
          : [],
        activeAccounts: parsed.activeAccounts && typeof parsed.activeAccounts === 'object'
          ? Object.fromEntries(Object.entries(parsed.activeAccounts).filter(([k, v]) => typeof k === 'string' && typeof v === 'string'))
          : {},
      };
      for (const p of this.data.projects) {
        if (!Array.isArray(p.actions)) p.actions = [];
      }
    } catch (err) {
      // Fichier corrompu : on le met de côté plutôt que de l'écraser silencieusement.
      const backup = `${this.file}.corrupt-${Date.now()}`;
      try { fs.renameSync(this.file, backup); } catch { /* ignore */ }
      console.error(`[store] fichier de configuration invalide, sauvegardé sous ${backup}`, err);
    }
  }

  save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2), 'utf8');
    fs.renameSync(tmp, this.file);
  }

  /* ---------- Paramètres ---------- */

  getSettings() {
    return { ...this.data.settings };
  }

  sanitizeSettings(s) {
    const out = { ...this.defaultSettings };
    if (SHELL_IDS.includes(s.defaultShell)) out.defaultShell = s.defaultShell;
    const t = Number(s.timeoutMinutes);
    if (Number.isFinite(t)) out.timeoutMinutes = Math.min(Math.max(Math.round(t), 1), 240);
    out.fetchOnOpen = s.fetchOnOpen !== false;
    out.bashTrace = s.bashTrace !== false;
    const ssh = s.ssh && typeof s.ssh === 'object' ? s.ssh : {};
    out.ssh = {
      enabled: ssh.enabled === true,
      identities: Array.isArray(ssh.identities) ? [...new Set(ssh.identities.filter((p) => typeof p === 'string' && p))].slice(0, 10) : [],
    };
    return out;
  }

  updateSettings(patch) {
    this.data.settings = this.sanitizeSettings({ ...this.data.settings, ...(patch || {}) });
    this.save();
    return this.getSettings();
  }

  /* ---------- Projets ---------- */

  listProjects() {
    return this.data.projects;
  }

  getProject(id) {
    const project = this.data.projects.find((p) => p.id === id);
    if (!project) throw new ValidationError('Projet introuvable.');
    return project;
  }

  findProjectByPath(p) {
    return this.data.projects.find((proj) => samePath(proj.path, p));
  }

  addProject({ name, path: projectPath }) {
    const cleanName = String(name || '').trim().slice(0, LIMITS.projectName) || path.basename(projectPath);
    const project = {
      id: crypto.randomUUID(),
      name: cleanName,
      path: projectPath,
      addedAt: Date.now(),
      actions: [],
    };
    this.data.projects.push(project);
    this.save();
    return project;
  }

  removeProject(id) {
    const before = this.data.projects.length;
    this.data.projects = this.data.projects.filter((p) => p.id !== id);
    if (this.data.projects.length === before) throw new ValidationError('Projet introuvable.');
    this.data.schedules = this.data.schedules.filter((s) => s.projectId !== id);
    this.save();
  }

  /* ---------- Actions ---------- */

  validateAction(input) {
    const name = String(input?.name ?? '').trim();
    const description = String(input?.description ?? '').trim();
    const script = String(input?.script ?? '').replace(/\r\n/g, '\n');
    const shell = ACTION_SHELL_IDS.includes(input?.shell) ? input.shell : 'default';

    if (!name) throw new ValidationError("Le nom de l'action est obligatoire.");
    if (name.length > LIMITS.actionName) throw new ValidationError(`Le nom ne doit pas dépasser ${LIMITS.actionName} caractères.`);
    if (description.length > LIMITS.actionDescription) throw new ValidationError(`La description ne doit pas dépasser ${LIMITS.actionDescription} caractères.`);
    if (!script.trim()) throw new ValidationError('Le script ne peut pas être vide.');
    if (script.length > LIMITS.script) throw new ValidationError('Le script est trop volumineux.');

    return { name, description, script, shell };
  }

  getAction(projectId, actionId) {
    const project = this.getProject(projectId);
    const action = project.actions.find((a) => a.id === actionId);
    if (!action) throw new ValidationError('Action introuvable.');
    return { project, action };
  }

  createAction(projectId, input) {
    const project = this.getProject(projectId);
    const data = this.validateAction(input);
    const now = Date.now();
    const action = { id: crypto.randomUUID(), ...data, createdAt: now, updatedAt: now, lastRun: null };
    project.actions.push(action);
    this.save();
    return action;
  }

  updateAction(projectId, actionId, input) {
    const { action } = this.getAction(projectId, actionId);
    Object.assign(action, this.validateAction(input), { updatedAt: Date.now() });
    this.save();
    return action;
  }

  removeAction(projectId, actionId) {
    const project = this.getProject(projectId);
    const before = project.actions.length;
    project.actions = project.actions.filter((a) => a.id !== actionId);
    if (project.actions.length === before) throw new ValidationError('Action introuvable.');
    this.data.schedules = this.data.schedules.filter((s) => !(s.projectId === projectId && s.actionId === actionId));
    this.save();
  }

  /**
   * Ajoute des actions (fichier d'import) à un projet. Même règle que la copie pour
   * les noms déjà utilisés : ignorées, ou remplacées si `replace` est vrai.
   */
  importActions(projectId, inputs, { replace = false } = {}) {
    const project = this.getProject(projectId);
    if (!Array.isArray(inputs) || !inputs.length) throw new ValidationError('Aucune action à importer.');
    const actions = inputs.slice(0, 200).map((input) => this.validateAction(input));
    const result = { created: 0, replaced: 0, skipped: 0 };
    const now = Date.now();
    for (const data of actions) {
      const existing = project.actions.find((a) => a.name.trim().toLowerCase() === data.name.toLowerCase());
      if (existing && !replace) {
        result.skipped += 1;
      } else if (existing) {
        Object.assign(existing, data, { updatedAt: now });
        result.replaced += 1;
      } else {
        project.actions.push({ id: crypto.randomUUID(), ...data, createdAt: now, updatedAt: now, lastRun: null });
        result.created += 1;
      }
    }
    this.save();
    return result;
  }

  /**
   * Copie des actions vers d'autres projets. Une action portant déjà le même nom
   * dans la destination est ignorée, ou remplacée si `replace` est vrai.
   */
  copyActions(sourceProjectId, actionIds, targetProjectIds, { replace = false } = {}) {
    const source = this.getProject(sourceProjectId);
    const ids = new Set(Array.isArray(actionIds) ? actionIds : []);
    const actions = source.actions.filter((a) => ids.has(a.id));
    if (!actions.length) throw new ValidationError('Sélectionnez au moins une action à copier.');
    const targets = [...new Set(Array.isArray(targetProjectIds) ? targetProjectIds : [])]
      .filter((id) => id !== sourceProjectId)
      .map((id) => this.getProject(id));
    if (!targets.length) throw new ValidationError('Sélectionnez au moins un projet de destination.');

    const result = { created: 0, replaced: 0, skipped: 0 };
    const now = Date.now();
    for (const target of targets) {
      for (const a of actions) {
        const data = { name: a.name, description: a.description, script: a.script, shell: a.shell };
        const existing = target.actions.find((t) => t.name.trim().toLowerCase() === a.name.trim().toLowerCase());
        if (existing && !replace) {
          result.skipped += 1;
        } else if (existing) {
          Object.assign(existing, data, { updatedAt: now });
          result.replaced += 1;
        } else {
          target.actions.push({ id: crypto.randomUUID(), ...data, createdAt: now, updatedAt: now, lastRun: null });
          result.created += 1;
        }
      }
    }
    this.save();
    return result;
  }

  setActionLastRun(projectId, actionId, lastRun) {
    const project = this.data.projects.find((p) => p.id === projectId);
    const action = project?.actions.find((a) => a.id === actionId);
    if (!action) return; // action supprimée entre-temps
    action.lastRun = lastRun;
    try { this.save(); } catch (err) { console.error('[store] sauvegarde impossible :', err); }
  }

  /* ---------- Comptes d'hébergement (jeton déjà chiffré par l'appelant) ---------- */

  listAccounts() {
    return this.data.accounts.map((a) => ({ ...a }));
  }

  getAccount(host, username) {
    const account = this.data.accounts.find((a) => a.host === host && a.username === username);
    return account ? { ...account } : null;
  }

  /** Ajoute ou remplace le compte (hôte + nom d'utilisateur). */
  setAccount(account) {
    this.data.accounts = this.data.accounts.filter((a) => !(a.host === account.host && a.username === account.username));
    this.data.accounts.push({ ...account });
    this.save();
  }

  /** Retire un compte, ou tous les comptes de l'hôte si `username` est absent. */
  removeAccount(host, username) {
    const before = this.data.accounts.length;
    this.data.accounts = this.data.accounts.filter((a) => !(a.host === host && (username === undefined || a.username === username)));
    if (this.data.accounts.length !== before) this.save();
  }

  getActiveAccount(host) {
    return this.data.activeAccounts[host] || null;
  }

  setActiveAccount(host, username) {
    if (username) this.data.activeAccounts[host] = username;
    else delete this.data.activeAccounts[host];
    this.save();
  }

  /* ---------- Programmations ---------- */

  listSchedules() {
    return this.data.schedules.map((s) => ({ ...s }));
  }

  findSchedule(id) {
    return this.data.schedules.find((s) => s.id === id) || null;
  }

  createSchedule(projectId, actionId, runAt) {
    this.getAction(projectId, actionId);
    const at = Number(runAt);
    const now = Date.now();
    if (!Number.isFinite(at)) throw new ValidationError('Date de programmation invalide.');
    if (at <= now) throw new ValidationError('La date de programmation doit être dans le futur.');
    if (at > now + MAX_SCHEDULE_AHEAD_MS) throw new ValidationError("La date de programmation doit être dans moins d'un an.");
    const schedule = { id: crypto.randomUUID(), projectId, actionId, runAt: at, createdAt: now, status: 'pending', error: null };
    this.data.schedules.push(schedule);
    this.save();
    return { ...schedule };
  }

  updateSchedule(id, patch) {
    const schedule = this.findSchedule(id);
    if (!schedule) return;
    Object.assign(schedule, patch);
    try { this.save(); } catch (err) { console.error('[store] sauvegarde impossible :', err); }
  }

  removeSchedule(id) {
    const before = this.data.schedules.length;
    this.data.schedules = this.data.schedules.filter((s) => s.id !== id);
    if (this.data.schedules.length === before) throw new ValidationError('Programmation introuvable.');
    this.save();
  }
}

/* ---------- Fichier d'export d'actions (.gitpilot.json) ---------- */

const ACTIONS_FORMAT = 'gitpilot-actions';

function buildActionsFile(projectName, actions) {
  const payload = {
    format: ACTIONS_FORMAT,
    version: 1,
    exportedAt: new Date().toISOString(),
    source: projectName,
    actions: actions.map(({ name, description, shell, script }) => ({ name, description, shell, script })),
  };
  return `${JSON.stringify(payload, null, 2)}
`;
}

/** Lit et vérifie un export ; les actions sont revalidées à l'import (importActions). */
function parseActionsFile(text) {
  let data;
  try { data = JSON.parse(String(text).replace(/^﻿/, '')); } catch { throw new ValidationError("Ce fichier n'est pas un JSON valide."); }
  if (data?.format !== ACTIONS_FORMAT || !Array.isArray(data.actions)) throw new ValidationError("Ce fichier n'est pas un export d'actions GitPilot.");
  if (Number(data.version) > 1) throw new ValidationError('Ce fichier provient d’une version plus récente de GitPilot.');
  const actions = data.actions
    .filter((a) => a && typeof a.name === 'string' && typeof a.script === 'string')
    .map((a) => ({ name: a.name, description: String(a.description || ''), shell: String(a.shell || 'default'), script: a.script }));
  if (!actions.length) throw new ValidationError('Aucune action valide dans ce fichier.');
  return { source: typeof data.source === 'string' ? data.source : null, actions };
}

module.exports = { Store, ValidationError, SHELL_IDS, buildActionsFile, parseActionsFile };
