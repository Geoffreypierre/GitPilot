'use strict';

const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');

class GitError extends Error {
  constructor(message, details) {
    super(message);
    this.userMessage = message;
    this.details = details;
  }
}

function gitEnv() {
  const env = { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' };
  // Évite qu'un fetch SSH reste bloqué en attente d'une passphrase.
  if (!env.GIT_SSH_COMMAND) env.GIT_SSH_COMMAND = 'ssh -o BatchMode=yes';
  delete env.ELECTRON_RUN_AS_NODE;
  return env;
}

function describeGitFailure(err, stderr) {
  const text = String(stderr || err?.message || '').trim();
  if (err?.code === 'ENOENT') {
    return "Git est introuvable. Installez Git et vérifiez qu'il est accessible dans le PATH.";
  }
  if (err?.killed || err?.signal === 'SIGTERM') {
    return 'La commande Git a dépassé le délai autorisé.';
  }
  if (/not a git repository/i.test(text)) return "Ce dossier n'est pas un dépôt Git.";
  if (/dubious ownership/i.test(text)) {
    return 'Git refuse ce dépôt (propriétaire différent). Ajoutez-le avec : git config --global --add safe.directory <chemin>';
  }
  if (/could not resolve host/i.test(text)) return 'Hôte distant injoignable (vérifiez votre connexion réseau).';
  if (/authentication failed|permission denied|could not read from remote/i.test(text)) {
    return "Accès au dépôt distant refusé (authentification requise ou droits insuffisants).";
  }
  const lines = text.split(/\r?\n/).filter(Boolean);
  return lines.slice(-3).join(' — ') || 'Erreur Git inconnue.';
}

/**
 * Exécute git avec un tableau d'arguments (aucun shell, aucune interpolation)
 * et le dépôt comme répertoire de travail : impossible d'impacter un autre projet.
 */
function runGit(cwd, args, { timeout = 30_000 } = {}) {
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      ['-c', 'core.quotepath=off', '-c', 'color.ui=never', ...args],
      { cwd, timeout, maxBuffer: 32 * 1024 * 1024, windowsHide: true, env: gitEnv() },
      (err, stdout, stderr) => {
        if (err) reject(new GitError(describeGitFailure(err, stderr), String(stderr || err.message)));
        else resolve(stdout);
      },
    );
  });
}

async function gitVersion() {
  try {
    const out = await runGit(process.cwd(), ['--version'], { timeout: 10_000 });
    return out.trim().replace(/^git version\s*/i, '');
  } catch {
    return null;
  }
}

/**
 * Vérifie qu'un chemin saisi par l'utilisateur est un dossier existant
 * contenant un dépôt Git (non bare). Retourne la racine du dépôt.
 */
async function validateRepository(inputPath) {
  const raw = String(inputPath || '').trim().replace(/^["']|["']$/g, '');
  if (!raw) throw new GitError('Veuillez renseigner le chemin du dépôt.');
  if (!path.isAbsolute(raw)) throw new GitError('Le chemin doit être absolu (ex. C:\\Projets\\mon-app ou /home/moi/mon-app).');

  const resolved = path.resolve(raw);
  let stat;
  try {
    stat = fs.statSync(resolved);
  } catch {
    throw new GitError(`Le dossier « ${resolved} » n'existe pas.`);
  }
  if (!stat.isDirectory()) throw new GitError(`« ${resolved} » n'est pas un dossier.`);

  let topLevel;
  try {
    topLevel = (await runGit(resolved, ['rev-parse', '--show-toplevel'], { timeout: 15_000 })).trim();
  } catch (err) {
    if (/n'est pas un dépôt Git|not a git repository/i.test(err.userMessage || '')) {
      throw new GitError(`« ${resolved} » n'est pas un dépôt Git valide.`);
    }
    throw err;
  }
  if (!topLevel) throw new GitError(`« ${resolved} » n'est pas un dépôt Git valide (dépôt bare ?).`);

  return { path: path.resolve(topLevel), isSubfolder: path.resolve(topLevel) !== resolved };
}

/** Contrôle rapide utilisé avant chaque opération sur un projet déjà enregistré. */
function assertProjectPath(projectPath) {
  try {
    if (!fs.statSync(projectPath).isDirectory()) throw new Error();
  } catch {
    throw new GitError(`Le dossier du projet est introuvable : ${projectPath}`);
  }
}

async function fetchAll(projectPath) {
  assertProjectPath(projectPath);
  const startedAt = Date.now();
  try {
    await runGit(projectPath, ['fetch', '--all', '--prune', '--quiet'], { timeout: 120_000 });
    return { ok: true, at: Date.now(), durationMs: Date.now() - startedAt };
  } catch (err) {
    return { ok: false, at: Date.now(), error: err.userMessage || err.message };
  }
}

async function currentBranch(projectPath) {
  const name = (await runGit(projectPath, ['branch', '--show-current'])).trim();
  if (name) return { name, detached: false };
  try {
    const sha = (await runGit(projectPath, ['rev-parse', '--short', 'HEAD'])).trim();
    return { name: `HEAD détachée (${sha})`, detached: true };
  } catch {
    return { name: '(aucun commit)', detached: true };
  }
}

const FIELD_SEP = '\x1f';
const REF_FORMAT = [
  '%(refname)',
  '%(refname:short)',
  '%(committerdate:unix)',
  '%(objectname:short)',
  '%(contents:subject)',
  '%(authorname)',
  '%(upstream:short)',
].join(FIELD_SEP);

/**
 * Liste toutes les branches locales et distantes triées par date du dernier commit
 * (la plus récente en premier).
 */
async function listBranches(projectPath) {
  assertProjectPath(projectPath);
  const [out, current] = await Promise.all([
    runGit(projectPath, ['for-each-ref', '--sort=-committerdate', `--format=${REF_FORMAT}`, 'refs/heads', 'refs/remotes']),
    currentBranch(projectPath),
  ]);

  const branches = [];
  for (const line of out.split('\n')) {
    if (!line.trim()) continue;
    const [ref, shortName, date, sha, subject, author, upstream] = line.split(FIELD_SEP);
    const isRemote = ref.startsWith('refs/remotes/');
    if (isRemote && ref.endsWith('/HEAD')) continue; // référence symbolique origin/HEAD
    const remote = isRemote ? ref.slice('refs/remotes/'.length).split('/')[0] : null;
    if (isRemote && shortName === remote) continue;
    branches.push({
      ref,
      name: shortName,
      type: isRemote ? 'remote' : 'local',
      remote,
      date: Number(date) * 1000 || 0,
      sha,
      subject: subject || '',
      author: author || '',
      upstream: upstream || null,
      current: !isRemote && !current.detached && shortName === current.name,
    });
  }
  return { current, branches };
}

async function summary(projectPath) {
  assertProjectPath(projectPath);
  const { current, branches } = await listBranches(projectPath);
  return {
    current,
    localCount: branches.filter((b) => b.type === 'local').length,
    remoteCount: branches.filter((b) => b.type === 'remote').length,
    lastActivity: branches.reduce((max, b) => Math.max(max, b.date), 0) || null,
  };
}

module.exports = { GitError, runGit, gitVersion, validateRepository, assertProjectPath, fetchAll, listBranches, summary };
