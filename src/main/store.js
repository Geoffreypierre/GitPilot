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
      ...defaults,
    };
    this.data = { version: 1, settings: { ...this.defaultSettings }, projects: [] };
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
    this.save();
  }

  setActionLastRun(projectId, actionId, lastRun) {
    const project = this.data.projects.find((p) => p.id === projectId);
    const action = project?.actions.find((a) => a.id === actionId);
    if (!action) return; // action supprimée entre-temps
    action.lastRun = lastRun;
    try { this.save(); } catch (err) { console.error('[store] sauvegarde impossible :', err); }
  }
}

module.exports = { Store, ValidationError, SHELL_IDS };
