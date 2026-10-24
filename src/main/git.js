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

// Commande SSH configurée dans GitPilot (assistant SSH) ; prioritaire quand elle est définie.
let managedSshCommand = null;
function setManagedSshCommand(command) {
  managedSshCommand = command || null;
}

/** Variables à transmettre aux scripts des actions pour qu'ils utilisent le même accès SSH. */
function sshEnv() {
  return managedSshCommand ? { GIT_SSH_COMMAND: managedSshCommand } : {};
}

function gitEnv({ batchSsh = true } = {}) {
  const env = { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' };
  if (managedSshCommand) {
    env.GIT_SSH_COMMAND = managedSshCommand;
    delete env.ELECTRON_RUN_AS_NODE;
    return env;
  }
  // Évite qu'un fetch SSH reste bloqué en attente d'une passphrase. GIT_SSH_COMMAND
  // l'emporte sur core.sshCommand : on ne le pose donc que si l'utilisateur n'a rien configuré.
  if (batchSsh && !env.GIT_SSH_COMMAND && !env.GIT_SSH) env.GIT_SSH_COMMAND = 'ssh -o BatchMode=yes';
  delete env.ELECTRON_RUN_AS_NODE;
  return env;
}

const SSH_CONFIG_TTL_MS = 60_000;
const sshConfigCache = new Map(); // cwd -> { at, promise }

/** Vrai si core.sshCommand est défini (dépôt, global ou système) pour ce dossier. */
function hasSshCommand(cwd) {
  const cached = sshConfigCache.get(cwd);
  if (cached && Date.now() - cached.at < SSH_CONFIG_TTL_MS) return cached.promise;
  const promise = new Promise((resolve) => {
    execFile('git', ['config', '--get', 'core.sshCommand'], { cwd, timeout: 10_000, windowsHide: true, env: gitEnv({ batchSsh: false }) },
      (err, stdout) => resolve(!err && Boolean(String(stdout).trim())));
  });
  sshConfigCache.set(cwd, { at: Date.now(), promise });
  return promise;
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
  if (/please tell me who you are|unable to auto-detect email/i.test(text)) {
    return 'Identité Git non configurée : renseignez user.name et user.email dans votre configuration Git.';
  }
  if (/would be overwritten by checkout|overwritten by checkout/i.test(text)) {
    return 'Des fichiers locaux seraient écrasés par le changement de branche.';
  }
  if (/permission denied \(publickey/i.test(text)) {
    return "Clé SSH refusée par le serveur. Vérifiez que votre clé publique est enregistrée sur votre compte (GitHub, GitLab…) et que Git utilise la bonne clé ou le bon agent SSH (réglage core.sshCommand).";
  }
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
async function runGit(cwd, args, { timeout = 30_000 } = {}) {
  const env = gitEnv({ batchSsh: managedSshCommand ? true : !(await hasSshCommand(cwd)) });
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      ['-c', 'core.quotepath=off', '-c', 'color.ui=never', ...args],
      { cwd, timeout, maxBuffer: 32 * 1024 * 1024, windowsHide: true, env },
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
    const kind = /permission denied \(publickey|host key verification failed/i.test(err.details || '') ? 'ssh-auth' : null;
    return { ok: false, at: Date.now(), error: err.userMessage || err.message, kind };
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
  '%(symref:short)',
].join(FIELD_SEP);

// Noms de branches principales, toujours considérées comme « par défaut ».
const MAIN_BRANCH_NAMES = new Set(['main', 'master']);

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
  const remoteDefaults = new Set(); // ex. « origin/main », cible de origin/HEAD
  for (const line of out.split('\n')) {
    if (!line.trim()) continue;
    const [ref, shortName, date, sha, subject, author, upstream, symref] = line.split(FIELD_SEP);
    const isRemote = ref.startsWith('refs/remotes/');
    if (isRemote && ref.endsWith('/HEAD')) { // référence symbolique origin/HEAD
      if (symref) remoteDefaults.add(symref);
      continue;
    }
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
  // Branche principale : main / master, ou la branche par défaut du remote (origin/HEAD),
  // en local comme en distant.
  const defaultNames = new Set(MAIN_BRANCH_NAMES);
  for (const d of remoteDefaults) defaultNames.add(d.slice(d.indexOf('/') + 1));
  for (const b of branches) {
    const base = b.type === 'remote' ? b.name.slice(b.remote.length + 1) : b.name;
    b.isDefault = defaultNames.has(base) || remoteDefaults.has(b.name);
  }
  return { current, branches };
}

/**
 * Supprime une branche locale (git branch -d / -D) ou distante (git push --delete).
 * La référence doit figurer dans la liste actuelle des branches du dépôt.
 */
async function deleteBranch(projectPath, ref, { force = false } = {}) {
  const { branches } = await listBranches(projectPath);
  const branch = branches.find((b) => b.ref === ref);
  if (!branch) throw new GitError('Branche introuvable : la liste est peut-être obsolète, actualisez-la.');
  if (branch.isDefault) throw new GitError(`« ${branch.name} » est une branche principale du dépôt : sa suppression est interdite.`);

  if (branch.type === 'local') {
    if (branch.current) throw new GitError('Impossible de supprimer la branche courante. Changez de branche avant de la supprimer.');
    const name = ref.slice('refs/heads/'.length);
    try {
      await runGit(projectPath, ['branch', force ? '-D' : '-d', '--', name]);
    } catch (err) {
      if (/not fully merged/i.test(err.details || '')) {
        throw new GitError(`La branche « ${name} » n'est pas entièrement fusionnée. Cochez « Forcer la suppression » pour la supprimer quand même (ses commits non fusionnés seront perdus).`);
      }
      throw err;
    }
  } else {
    const name = ref.slice(`refs/remotes/${branch.remote}/`.length);
    await runGit(projectPath, ['push', branch.remote, '--delete', `refs/heads/${name}`], { timeout: 120_000 });
  }
  return { ref, type: branch.type, name: branch.name };
}

/** Modifications non commitées (fichiers suivis et non suivis). */
async function workingTreeStatus(projectPath) {
  assertProjectPath(projectPath);
  const out = await runGit(projectPath, ['status', '--porcelain=v1', '-z', '--untracked-files=all']);
  const entries = out.split('\0');
  const files = [];
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    if (entry.length < 4) continue;
    const code = entry.slice(0, 2);
    files.push({ code: code.trim() || code, path: entry.slice(3) });
    if (code[0] === 'R' || code[0] === 'C') i += 1; // chemin d'origine du renommage
  }
  return { count: files.length, files: files.slice(0, 50) };
}

const MAX_MESSAGE_LENGTH = 2000;

/**
 * Bascule sur une branche (git switch). Une branche distante sans équivalent local
 * est extraite dans une nouvelle branche locale qui la suit. S'il y a des modifications
 * non commitées, `prepare` indique quoi en faire : { mode: 'commit' | 'stash', message }.
 */
async function checkoutBranch(projectPath, ref, { prepare = null } = {}) {
  const { branches } = await listBranches(projectPath);
  const branch = branches.find((b) => b.ref === ref);
  if (!branch) throw new GitError('Branche introuvable : la liste est peut-être obsolète, actualisez-la.');
  if (branch.current) return { branch: branch.name, prepared: null };

  let localName = branch.name;
  let create = false;
  if (branch.type === 'remote') {
    localName = branch.name.slice(branch.remote.length + 1);
    create = !branches.some((b) => b.type === 'local' && b.name === localName);
    if (!create && branches.find((b) => b.type === 'local' && b.name === localName)?.current) {
      return { branch: localName, prepared: null };
    }
  }

  const status = await workingTreeStatus(projectPath);
  let prepared = null;
  if (status.count) {
    if (!prepare) throw Object.assign(new GitError(`Le dépôt contient ${status.count} modification(s) non commitée(s).`), { kind: 'dirty' });
    const message = String(prepare.message || '').trim();
    if (!message) throw new GitError('Le message ne peut pas être vide.');
    if (message.length > MAX_MESSAGE_LENGTH) throw new GitError('Le message est trop long.');
    if (prepare.mode === 'commit') {
      await runGit(projectPath, ['add', '-A']);
      await runGit(projectPath, ['commit', '-m', message], { timeout: 120_000 });
    } else if (prepare.mode === 'stash') {
      await runGit(projectPath, ['stash', 'push', '--include-untracked', '-m', message], { timeout: 120_000 });
    } else {
      throw new GitError('Choix inconnu pour les modifications en cours.');
    }
    prepared = prepare.mode;
  }

  if (create) await runGit(projectPath, ['switch', '--create', localName, '--track', branch.name], { timeout: 60_000 });
  else await runGit(projectPath, ['switch', localName], { timeout: 60_000 });
  return { branch: localName, prepared, created: create };
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

module.exports = { GitError, setManagedSshCommand, sshEnv, runGit, gitVersion, validateRepository, assertProjectPath, fetchAll, listBranches, deleteBranch, workingTreeStatus, checkoutBranch, summary };
