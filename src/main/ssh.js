'use strict';

const { execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { findBash } = require('./runner');

const IS_WIN = process.platform === 'win32';
const TEST_TIMEOUT_MS = 20_000;
const KEY_NAMES = ['gitpilot_ed25519', 'id_ed25519', 'id_ecdsa', 'id_rsa'];
const GITPILOT_KEY = 'gitpilot_ed25519';
// Réponses des serveurs Git quand l'authentification SSH réussit (GitHub, GitLab, Bitbucket…).
const AUTH_OK_RE = /successfully authenticated|welcome to gitlab|logged in as|authenticated via/i;

class SshError extends Error {
  constructor(message) {
    super(message);
    this.userMessage = message;
  }
}

/* ---------- Binaires ---------- */

function exists(p) {
  try { return fs.statSync(p).isFile(); } catch { return false; }
}

/**
 * Sous Windows, l'OpenSSH du système est préféré : contrairement au ssh fourni
 * avec Git, il utilise l'agent SSH de Windows. Sinon, ssh de Git ou du PATH.
 */
function binary(name) {
  if (IS_WIN) {
    const system = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'OpenSSH', `${name}.exe`);
    if (exists(system)) return system;
    const bash = findBash();
    const fromGit = bash && path.resolve(path.dirname(bash), '..', 'usr', 'bin', `${name}.exe`);
    if (fromGit && exists(fromGit)) return fromGit;
    return null;
  }
  return name; // résolu via le PATH
}

function sshDir() {
  return path.join(os.homedir(), '.ssh');
}

/** Clés privées candidates (avec leur clé publique) présentes dans ~/.ssh. */
function existingKeys() {
  return KEY_NAMES.map((n) => path.join(sshDir(), n)).filter((p) => exists(p) && exists(`${p}.pub`));
}

function run(bin, args, timeout = TEST_TIMEOUT_MS) {
  const env = { ...process.env, SSH_ASKPASS_REQUIRE: 'never' };
  delete env.SSH_ASKPASS;
  delete env.GIT_ASKPASS;
  delete env.ELECTRON_RUN_AS_NODE;
  return new Promise((resolve) => {
    execFile(bin, args, { timeout, windowsHide: true, env }, (err, stdout, stderr) => {
      resolve({ err, out: `${stdout || ''}${stderr || ''}` });
    });
  });
}

/* ---------- Test d'accès ---------- */

/** Teste l'authentification SSH sur l'hôte Git (sans aucune saisie possible). */
async function testAccess(target, { identity = null } = {}) {
  const bin = binary('ssh');
  if (!bin) throw new SshError("Aucun client SSH trouvé sur ce système.");
  const args = ['-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=accept-new', '-o', 'ConnectTimeout=10', '-T'];
  if (target.port) args.push('-p', String(target.port));
  if (identity) args.push('-i', identity, '-o', 'IdentitiesOnly=yes');
  args.push(`${target.user || 'git'}@${target.host}`);
  const { err, out } = await run(bin, args);
  if (err?.code === 'ENOENT') throw new SshError("Aucun client SSH trouvé sur ce système.");
  const lastLines = out.trim().split(/\r?\n/).filter(Boolean).slice(-2).join(' — ');
  return { ok: AUTH_OK_RE.test(out), message: lastLines };
}

/**
 * Cherche une configuration qui fonctionne : d'abord la configuration par défaut
 * (agent SSH, ~/.ssh/config), puis chaque clé de ~/.ssh.
 */
async function detect(target) {
  const first = await testAccess(target);
  if (first.ok) return { ok: true, identity: null, method: IS_WIN ? 'agent' : 'default' };
  let last = first;
  for (const key of existingKeys()) {
    last = await testAccess(target, { identity: key });
    if (last.ok) return { ok: true, identity: key, method: 'key' };
  }
  return { ok: false, message: last.message };
}

/* ---------- Clé dédiée à GitPilot ---------- */

/** Crée ~/.ssh/gitpilot_ed25519 (sans phrase de passe) si elle n'existe pas encore. */
async function ensureGitPilotKey() {
  const file = path.join(sshDir(), GITPILOT_KEY);
  if (!exists(file) || !exists(`${file}.pub`)) {
    const keygen = binary('ssh-keygen');
    if (!keygen) throw new SshError("ssh-keygen est introuvable sur ce système.");
    fs.mkdirSync(sshDir(), { recursive: true, mode: 0o700 });
    const { err, out } = await run(keygen, ['-t', 'ed25519', '-N', '', '-C', `gitpilot@${os.hostname()}`, '-f', file], 30_000);
    if (err || !exists(`${file}.pub`)) throw new SshError(`Création de la clé impossible : ${out.trim() || err?.message}`);
  }
  return { path: file, publicKey: fs.readFileSync(`${file}.pub`, 'utf8').trim() };
}

/** Page d'ajout de clé SSH du serveur. */
function keyPageUrl(host) {
  return host === '/* github.com */' ? 'https://github.com/settings/ssh/new' : `https://${host}/-/user_settings/ssh_keys`;
}

/* ---------- Configuration gérée par GitPilot ---------- */

const shQuote = (s) => `'${String(s).replace(/\\/g, '/').replace(/'/g, `'\\''`)}'`;

/** Seules les clés de ~/.ssh connues de GitPilot sont acceptées. */
function isAllowedIdentity(p) {
  return typeof p === 'string' && existingKeys().some((k) => path.resolve(k) === path.resolve(p));
}

/**
 * Commande SSH utilisée par Git dans GitPilot (GIT_SSH_COMMAND), ou null si
 * la configuration n'est pas activée. Git l'exécute via un shell POSIX.
 */
function buildCommand(config) {
  if (!config?.enabled) return null;
  const bin = binary('ssh');
  if (!bin) return null;
  const ids = (config.identities || []).filter(isAllowedIdentity);
  return [shQuote(bin), '-o', 'BatchMode=yes', ...ids.flatMap((id) => ['-i', shQuote(id)])].join(' ');
}

module.exports = {
  SshError, testAccess, detect, ensureGitPilotKey, keyPageUrl, isAllowedIdentity, buildCommand, binary,
};
