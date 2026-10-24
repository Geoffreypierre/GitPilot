'use strict';

const { app, BrowserWindow, ipcMain, dialog, shell, Menu } = require('electron');
const path = require('path');
const { Store, buildActionsFile, parseActionsFile } = require('./src/main/store');
const git = require('./src/main/git');
const { Runner, availableShells, findBash } = require('./src/main/runner');
const { Scheduler } = require('./src/main/scheduler');
const hosting = require('./src/main/hosting');
const ssh = require('./src/main/ssh');
const history = require('./src/main/history');
const forge = require('./src/main/forge');
const fs = require('fs');


let mainWindow = null;
let store;
let scheduler;
let accounts;
const protectionCache = new Map(); // projectId -> { at, data }
const PROTECTION_TTL_MS = 5 * 60_000;
const runner = new Runner();
const fetchState = new Map(); // projectId -> dernier résultat de git fetch

// Dossier de données alternatif (tests, utilisation portable).
if (process.env.GITPILOT_DATA_DIR) {
  app.setPath('userData', path.resolve(process.env.GITPILOT_DATA_DIR));
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1320,
    height: 860,
    minWidth: 960,
    minHeight: 620,
    title: 'GitPilot',
    backgroundColor: '#1f1e24',
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'src', 'preload', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  });

  mainWindow.loadFile(path.join(__dirname, 'src', 'renderer', 'index.html'));
  mainWindow.once('ready-to-show', () => mainWindow.show());

  // Le renderer n'a pas le droit d'ouvrir de fenêtres ni de naviguer ailleurs.
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith('file://')) event.preventDefault();
  });
  mainWindow.on('closed', () => { mainWindow = null; });
}

function send(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload);
}

/** Enregistre un handler IPC renvoyant toujours { ok, data } ou { ok: false, error }. */
function handle(channel, fn) {
  ipcMain.handle(channel, async (event, ...args) => {
    const url = event.senderFrame?.url || '';
    if (!url.startsWith('file://')) return { ok: false, error: 'Origine non autorisée.' };
    try {
      return { ok: true, data: await fn(...args) };
    } catch (err) {
      if (!err.userMessage) console.error(`[ipc:${channel}]`, err);
      return { ok: false, error: err.userMessage || err.message || String(err) };
    }
  });
}

function publicProject(p) {
  return {
    id: p.id,
    name: p.name,
    path: p.path,
    addedAt: p.addedAt,
    actions: p.actions,
    lastFetch: fetchState.get(p.id) || null,
  };
}

/** Lance une action enregistrée (clic dans l'interface ou programmation). */
function startAction(projectId, actionId, schedule = null) {
  const { project, action } = store.getAction(projectId, actionId);
  if (runner.isRunning(projectId, actionId)) {
    throw Object.assign(new Error(), { userMessage: "Cette action est déjà en cours d'exécution." });
  }
  git.assertProjectPath(project.path);
  const settings = store.getSettings();
  const shellId = action.shell && action.shell !== 'default' ? action.shell : settings.defaultShell;
  return runner.start({
    project,
    action,
    shellId,
    timeoutMs: settings.timeoutMinutes * 60_000,
    bashTrace: settings.bashTrace,
    note: schedule ? `Exécution programmée (prévue le ${new Date(schedule.runAt).toLocaleString('fr-FR')})` : null,
    extraEnv: git.sshEnv(),
  });
}

/** Branches protégées côté serveur (GitLab / GitHub), si un compte est connecté pour l'hôte du remote. */
async function projectProtection(project, refresh) {
  const cached = protectionCache.get(project.id);
  if (!refresh && cached && Date.now() - cached.at < PROTECTION_TTL_MS) return cached.data;

  let data;
  const remote = await hosting.projectRemote(project.path).catch(() => null);
  if (!remote) {
    data = { status: 'none' };
  } else {
    const base = { host: remote.host, provider: remote.provider, remote: remote.name };
    try {
      const token = await accounts.getToken(remote.host);
      data = token
        ? { status: 'ok', ...base, branches: await hosting.protectedBranches(remote, token) }
        : { status: 'disconnected', ...base, oauth: hosting.oauthAvailable(remote.host) };
    } catch (err) {
      data = { status: 'error', ...base, error: err.userMessage || err.message };
    }
  }
  protectionCache.set(project.id, { at: Date.now(), data });
  return data;
}

/** Ouvre une URL https dans le navigateur (adresses fournies par le serveur OAuth). */
async function openHttps(url) {
  let parsed;
  try { parsed = new URL(url); } catch { return; }
  if (parsed.protocol === 'https:') await shell.openExternal(parsed.href);
}

async function doFetch(project) {
  const result = await git.fetchAll(project.path);
  fetchState.set(project.id, result);
  return result;
}

function registerIpc() {
  /* ----- Application ----- */
  handle('app:info', async () => {
    return {
      platform: process.platform,
      version: app.getVersion(),
      gitVersion: await git.gitVersion(),
      dataFile: store.file,
      shells: availableShells(),
    };
  });

  handle('settings:get', () => store.getSettings());
  // La configuration SSH ne se modifie que via l'assistant (chemins de clés vérifiés).
  handle('settings:update', ({ ssh: _ignored, ...patch } = {}) => store.updateSettings(patch));

  handle('dialog:browse', async () => {
    const res = await dialog.showOpenDialog(mainWindow, {
      title: 'Sélectionner un dépôt Git',
      properties: ['openDirectory'],
    });
    return res.canceled ? null : res.filePaths[0];
  });

  /* ----- Projets ----- */
  handle('projects:list', () => store.listProjects().map(publicProject));

  handle('projects:add', async ({ path: inputPath, name } = {}) => {
    const repo = await git.validateRepository(inputPath);
    const existing = store.findProjectByPath(repo.path);
    if (existing) {
      throw Object.assign(new Error(), { userMessage: `Ce dépôt est déjà présent dans le dashboard sous le nom « ${existing.name} ».` });
    }
    const project = store.addProject({ name, path: repo.path });
    const fetch = await doFetch(project);
    return { project: publicProject(project), fetch, normalizedFrom: repo.isSubfolder ? path.resolve(inputPath) : null };
  });

  handle('projects:remove', (id) => {
    runner.cancelProject(id);
    store.removeProject(id);
    scheduler.prune();
    fetchState.delete(id);
    protectionCache.delete(id);
    return true;
  });

  handle('projects:summary', async (id) => {
    const project = store.getProject(id);
    return git.summary(project.path);
  });

  handle('projects:branches', async (id, { fetch = false } = {}) => {
    const project = store.getProject(id);
    git.assertProjectPath(project.path);
    const fetchResult = fetch ? await doFetch(project) : fetchState.get(id) || null;
    const data = await git.listBranches(project.path);
    return { ...data, fetch: fetchResult };
  });

  handle('projects:protection', async (id, { refresh = false } = {}) => {
    const project = store.getProject(id);
    git.assertProjectPath(project.path);
    return projectProtection(project, refresh === true);
  });

  /* ----- Historique ----- */
  handle('git:log', async (id, { ref, skip = 0 } = {}) => {
    const project = store.getProject(id);
    git.assertProjectPath(project.path);
    return history.commitLog(project.path, String(ref || ''), { skip });
  });
  /* ----- Checkout ----- */
  handle('git:status', async (id) => {
    const project = store.getProject(id);
    return git.workingTreeStatus(project.path);
  });
  handle('git:checkout', async (id, { ref, prepare = null } = {}) => {
    const project = store.getProject(id);
    const clean = prepare && { mode: String(prepare.mode || ''), message: String(prepare.message || '') };
    const result = await git.checkoutBranch(project.path, String(ref || ''), { prepare: clean });
    protectionCache.delete(id);
    return result;
  });

  /* ----- Merge requests et threads (GitLab / GitHub) ----- */
  const userError = (message) => Object.assign(new Error(message), { userMessage: message });
  const SHA_RE = /^[0-9a-f]{7,40}$/i;

  /** Remote du projet, branche source côté serveur et branches cibles possibles. */
  async function mergeRequestInfo(projectId, ref) {
    const project = store.getProject(projectId);
    git.assertProjectPath(project.path);
    const remote = await hosting.projectRemote(project.path);
    if (!remote) throw userError("Ce projet n'a pas de dépôt distant GitHub ou GitLab.");
    const { branches } = await git.listBranches(project.path);
    const source = branches.find((b) => b.ref === ref);
    if (!source) throw userError('Branche introuvable : actualisez la liste.');
    const prefix = `${remote.name}/`;
    const onRemote = branches.filter((b) => b.type === 'remote' && b.remote === remote.name);
    const sourceName = source.type === 'remote' ? source.name.slice(source.remote.length + 1) : source.name;
    const published = source.type === 'remote' ? source.remote === remote.name : onRemote.some((b) => b.name === `${prefix}${sourceName}`);
    const targets = onRemote.map((b) => b.name.slice(prefix.length)).filter((n) => n !== sourceName);
    const defaultTarget = onRemote.find((b) => b.isDefault)?.name.slice(prefix.length) || targets[0] || null;
    let connected = false;
    try { connected = Boolean(await accounts.getToken(remote.host)); } catch { connected = false; }
    return {
      remote, host: remote.host, provider: remote.provider, sourceName, published, targets, defaultTarget, connected,
      title: source.subject || sourceName,
    };
  }

  async function tokenFor(remote) {
    const token = await accounts.getToken(remote.host);
    if (!token) throw userError(`Connectez votre compte ${remote.host} (Paramètres → Comptes) pour utiliser cette fonction.`);
    return token;
  }

  handle('hosting:mergeRequestInfo', async (projectId, ref) => {
    const { remote: _remote, ...info } = await mergeRequestInfo(projectId, String(ref || ''));
    return info;
  });
  handle('hosting:createMergeRequest', async (projectId, input = {}) => {
    const info = await mergeRequestInfo(projectId, String(input.ref || ''));
    if (!info.published) throw userError(`La branche « ${info.sourceName} » n'existe pas sur ${info.host} : publiez-la avant de créer une merge request.`);
    const target = String(input.target || '');
    if (!info.targets.includes(target)) throw userError('Branche cible inconnue.');
    const title = String(input.title || '').trim();
    if (!title) throw userError('Le titre est obligatoire.');
    if (title.length > 255) throw userError('Le titre ne doit pas dépasser 255 caractères.');
    const description = String(input.description || '');
    if (description.length > 50_000) throw userError('La description est trop longue.');
    const token = await tokenFor(info.remote);
    return hosting.createMergeRequest(info.remote, token, {
      source: info.sourceName, target, title, description, draft: input.draft === true, removeSource: input.removeSource === true,
    });
  });

  async function threadContext(projectId, sha) {
    if (!SHA_RE.test(String(sha || ''))) throw userError('Identifiant de commit invalide.');
    const project = store.getProject(projectId);
    git.assertProjectPath(project.path);
    return hosting.projectRemote(project.path).catch(() => null);
  }
  const cleanBody = (body) => {
    const text = String(body || '').trim();
    if (!text) throw userError('Le commentaire est vide.');
    if (text.length > 50_000) throw userError('Le commentaire est trop long.');
    return text;
  };

  handle('hosting:threads', async (projectId, sha) => {
    const remote = await threadContext(projectId, sha);
    if (!remote) return { status: 'none' };
    let token = null;
    try { token = await accounts.getToken(remote.host); } catch (err) { return { status: 'error', host: remote.host, error: err.userMessage || err.message }; }
    if (!token) return { status: 'disconnected', host: remote.host, provider: remote.provider };
    try {
      return { status: 'ok', host: remote.host, provider: remote.provider, threads: await hosting.commitThreads(remote, token, sha) };
    } catch (err) {
      return { status: 'error', host: remote.host, provider: remote.provider, error: err.userMessage || err.message };
    }
  });
  handle('hosting:createThread', async (projectId, sha, input = {}) => {
    const remote = await threadContext(projectId, sha);
    if (!remote) throw userError("Ce projet n'a pas de dépôt distant GitHub ou GitLab.");
    const a = input.anchor;
    const int = (v) => (Number.isInteger(v) && v > 0 ? v : null);
    const anchor = a && typeof a.path === 'string' && a.path.length < 1000 ? {
      path: a.path, oldPath: typeof a.oldPath === 'string' ? a.oldPath : a.path,
      oldLine: int(a.oldLine), newLine: int(a.newLine), position: int(a.position),
    } : null;
    const parent = SHA_RE.test(String(input.parent || '')) ? String(input.parent) : null;
    return hosting.createCommitThread(remote, await tokenFor(remote), sha, { body: cleanBody(input.body), anchor, parent });
  });
  handle('hosting:replyThread', async (projectId, sha, threadId, body) => {
    const remote = await threadContext(projectId, sha);
    if (!remote) throw userError("Ce projet n'a pas de dépôt distant GitHub ou GitLab.");
    if (!/^[\w-]{1,100}$/.test(String(threadId || ''))) throw userError('Thread inconnu.');
    return hosting.replyCommitThread(remote, await tokenFor(remote), sha, String(threadId), cleanBody(body));
  });
  /* ----- Merge requests : onglet et page de détail ----- */
  const BRANCH_NAME_RE = /^[^\s~^:?*[\\]{1,255}$/;
  const cleanAnchor = (a) => {
    const int = (v) => (Number.isInteger(v) && v > 0 ? v : null);
    return a && typeof a.path === 'string' && a.path.length < 1000 ? {
      path: a.path, oldPath: typeof a.oldPath === 'string' ? a.oldPath : a.path,
      oldLine: int(a.oldLine), newLine: int(a.newLine), position: int(a.position),
    } : null;
  };
  const cleanThreadId = (id) => {
    if (!/^[\w-]{1,100}$/.test(String(id || ''))) throw userError('Thread inconnu.');
    return String(id);
  };

  /** Remote principal du projet et jeton du compte associé. */
  async function forgeContext(projectId) {
    const project = store.getProject(projectId);
    git.assertProjectPath(project.path);
    const remote = await hosting.projectRemote(project.path).catch(() => null);
    if (!remote) throw userError("Ce projet n'a pas de dépôt distant GitHub ou GitLab.");
    return { project, remote, token: await tokenFor(remote) };
  }

  handle('mr:list', async (projectId, { state = 'opened', page = 1 } = {}) => {
    const project = store.getProject(projectId);
    git.assertProjectPath(project.path);
    const remote = await hosting.projectRemote(project.path).catch(() => null);
    if (!remote) return { status: 'none' };
    const base = { host: remote.host, provider: remote.provider };
    try {
      const token = await accounts.getToken(remote.host);
      if (!token) return { status: 'disconnected', ...base };
      return { status: 'ok', ...base, ...(await forge.listMergeRequests(remote, token, { state, page })) };
    } catch (err) {
      return { status: 'error', ...base, error: err.userMessage || err.message };
    }
  });
  handle('mr:get', async (projectId, number) => {
    const { remote, token } = await forgeContext(projectId);
    return { host: remote.host, provider: remote.provider, ...(await forge.getMergeRequest(remote, token, number)) };
  });
  handle('mr:targets', async (projectId) => {
    const project = store.getProject(projectId);
    const remote = await hosting.projectRemote(project.path).catch(() => null);
    if (!remote) return [];
    const { branches } = await git.listBranches(project.path);
    const prefix = `${remote.name}/`;
    return branches.filter((b) => b.type === 'remote' && b.remote === remote.name).map((b) => b.name.slice(prefix.length)).sort();
  });
  handle('mr:update', async (projectId, number, changes = {}) => {
    const clean = {};
    if (changes.title !== undefined) {
      clean.title = String(changes.title || '').trim();
      if (!clean.title) throw userError('Le titre est obligatoire.');
      if (clean.title.length > 255) throw userError('Le titre ne doit pas dépasser 255 caractères.');
    }
    if (changes.description !== undefined) {
      clean.description = String(changes.description || '');
      if (clean.description.length > 50_000) throw userError('La description est trop longue.');
    }
    if (changes.target !== undefined) {
      clean.target = String(changes.target || '');
      if (!BRANCH_NAME_RE.test(clean.target)) throw userError('Branche cible invalide.');
    }
    if (changes.draft !== undefined) clean.draft = changes.draft === true;
    if (changes.state !== undefined) {
      if (!['close', 'reopen'].includes(changes.state)) throw userError('Action inconnue.');
      clean.state = changes.state;
    }
    const { remote, token } = await forgeContext(projectId);
    return forge.updateMergeRequest(remote, token, number, clean);
  });
  handle('mr:merge', async (projectId, number, options = {}) => {
    const { remote, token } = await forgeContext(projectId);
    return forge.mergeMergeRequest(remote, token, number, { squash: options.squash === true, removeSource: options.removeSource === true });
  });
  handle('mr:commits', async (projectId, number) => {
    const { remote, token } = await forgeContext(projectId);
    return forge.mergeRequestCommits(remote, token, number);
  });
  handle('mr:changes', async (projectId, number) => {
    const { remote, token } = await forgeContext(projectId);
    return forge.mergeRequestChanges(remote, token, number);
  });
  handle('mr:threads', async (projectId, number) => {
    const { remote, token } = await forgeContext(projectId);
    return forge.mergeRequestThreads(remote, token, number);
  });
  handle('mr:createThread', async (projectId, number, input = {}) => {
    const { remote, token } = await forgeContext(projectId);
    return forge.createMergeRequestThread(remote, token, number, { body: cleanBody(input.body), anchor: cleanAnchor(input.anchor) });
  });
  handle('mr:replyThread', async (projectId, number, threadId, body) => {
    const { remote, token } = await forgeContext(projectId);
    return forge.replyMergeRequestThread(remote, token, number, cleanThreadId(threadId), cleanBody(body));
  });
  handle('mr:resolveThread', async (projectId, number, threadId, resolved) => {
    const { remote, token } = await forgeContext(projectId);
    return forge.resolveMergeRequestThread(remote, token, number, cleanThreadId(threadId), resolved === true);
  });

  handle('app:openUrl', async (url) => {
    await openHttps(String(url || ''));
    return true;
  });

  handle('git:avatars', async (id, { ref = null, emails = [] } = {}) => {
    const project = store.getProject(id);
    git.assertProjectPath(project.path);
    const remote = await hosting.projectRemote(project.path).catch(() => null);
    if (!remote || !Array.isArray(emails)) return {};
    let token = null;
    try { token = await accounts.getToken(remote.host); } catch { /* sans compte : API publique */ }
    // Nom de la branche côté serveur : refs/remotes/origin/x → x, refs/heads/x → x.
    const branch = typeof ref === 'string' ? ref.replace(/^refs\/(heads|remotes\/[^/]+)\//, '') : null;
    return hosting.authorAvatars(remote, token, { branch, emails });
  });
  handle('git:commit', async (id, sha) => {
    const project = store.getProject(id);
    git.assertProjectPath(project.path);
    return history.commitDetail(project.path, sha);
  });

  handle('projects:deleteBranch', async (id, { ref, force = false } = {}) => {
    const project = store.getProject(id);
    git.assertProjectPath(project.path);
    return git.deleteBranch(project.path, String(ref || ''), { force: force === true });
  });

  handle('projects:openFolder', async (id) => {
    const project = store.getProject(id);
    git.assertProjectPath(project.path);
    const err = await shell.openPath(project.path);
    if (err) throw Object.assign(new Error(err), { userMessage: err });
    return true;
  });

  /* ----- Actions ----- */
  handle('actions:create', (projectId, input) => store.createAction(projectId, input));
  handle('actions:update', (projectId, actionId, input) => store.updateAction(projectId, actionId, input));
  handle('actions:remove', (projectId, actionId) => {
    if (runner.isRunning(projectId, actionId)) {
      throw Object.assign(new Error(), { userMessage: "Impossible de supprimer une action en cours d'exécution." });
    }
    store.removeAction(projectId, actionId);
    scheduler.prune();
    return true;
  });
  /* ----- Export / import d'actions (fichier .gitpilot.json) ----- */
  handle('actions:export', async (projectId, actionIds) => {
    const project = store.getProject(projectId);
    const ids = new Set(Array.isArray(actionIds) ? actionIds : []);
    const actions = project.actions.filter((a) => ids.has(a.id));
    if (!actions.length) throw Object.assign(new Error(), { userMessage: 'Sélectionnez au moins une action à exporter.' });
    const safeName = project.name.replace(/[^\w.-]+/g, '-').replace(/^-+|-+$/g, '') || 'projet';
    const res = await dialog.showSaveDialog(mainWindow, {
      title: 'Exporter des actions',
      defaultPath: path.join(app.getPath('documents'), `${safeName}-actions.gitpilot.json`),
      filters: [{ name: 'Actions GitPilot', extensions: ['json'] }],
    });
    if (res.canceled || !res.filePath) return null;
    fs.writeFileSync(res.filePath, buildActionsFile(project.name, actions), 'utf8');
    return { file: res.filePath, count: actions.length };
  });
  handle('actions:readImport', async () => {
    const res = await dialog.showOpenDialog(mainWindow, {
      title: 'Importer des actions',
      properties: ['openFile'],
      filters: [{ name: 'Actions GitPilot', extensions: ['json'] }],
    });
    if (res.canceled || !res.filePaths[0]) return null;
    const file = res.filePaths[0];
    if (fs.statSync(file).size > 2 * 1024 * 1024) {
      throw Object.assign(new Error(), { userMessage: 'Fichier trop volumineux pour un export d’actions.' });
    }
    return { file: path.basename(file), ...parseActionsFile(fs.readFileSync(file, 'utf8')) };
  });
  handle('actions:import', (projectId, actions, options) => store.importActions(projectId, actions, options));
  handle('actions:copy', (sourceProjectId, actionIds, targetProjectIds, options) => (
    store.copyActions(sourceProjectId, actionIds, targetProjectIds, options)
  ));

  // Le renderer ne transmet que des identifiants : le script exécuté est toujours
  // celui enregistré par l'utilisateur, dans le dossier du projet concerné.
  handle('actions:run', (projectId, actionId) => startAction(projectId, actionId));

  /* ----- Comptes GitLab / GitHub ----- */
  // Le jeton ne quitte jamais le processus principal.
  handle('accounts:list', () => accounts.list());
  handle('accounts:oauthAvailable', (host) => hosting.oauthAvailable(hosting.normalizeHost(host)));
  handle('accounts:connect', async ({ host, token } = {}) => {
    const account = await accounts.connectToken(host, token);
    protectionCache.clear();
    return account;
  });
  // OAuth : start renvoie le code à afficher et ouvre le navigateur ; wait attend l'autorisation.
  handle('accounts:oauthStart', async (host) => {
    const flow = await accounts.oauthStart(host);
    await openHttps(flow.verificationUri);
    return flow;
  });
  handle('accounts:oauthOpen', async (flowId) => {
    const flow = accounts.flows.get(flowId);
    if (flow) await openHttps(flow.verificationUri);
    return true;
  });
  handle('accounts:oauthWait', async (flowId) => {
    const account = await accounts.oauthWait(flowId);
    protectionCache.clear();
    return account;
  });
  handle('accounts:oauthCancel', (flowId) => accounts.oauthCancel(flowId));
  handle('accounts:remove', (host, username) => {
    accounts.remove(hosting.normalizeHost(host), typeof username === 'string' ? username : undefined);
    protectionCache.clear();
    return true;
  });
  handle('accounts:setActive', (host, username) => {
    accounts.setActive(hosting.normalizeHost(host), String(username || ''));
    protectionCache.clear();
    return true;
  });
  handle('accounts:openTokenPage', async (host) => {
    await shell.openExternal(hosting.tokenPageUrl(hosting.normalizeHost(host)));
    return true;
  });

  /* ----- Assistant SSH ----- */
  async function sshTarget(projectId) {
    const project = store.getProject(projectId);
    git.assertProjectPath(project.path);
    const remote = await hosting.projectRemote(project.path);
    if (!remote?.ssh) throw new ssh.SshError("Le remote de ce projet n'utilise pas SSH.");
    return remote.ssh;
  }

  function applySsh() {
    git.setManagedSshCommand(ssh.buildCommand(store.getSettings().ssh));
  }

  handle('ssh:status', () => {
    const { enabled, identities } = store.getSettings().ssh;
    return { enabled, identities: identities.filter(ssh.isAllowedIdentity), client: ssh.binary('ssh') };
  });
  handle('ssh:detect', async (projectId) => {
    const target = await sshTarget(projectId);
    return { host: target.host, ...(await ssh.detect(target)) };
  });
  handle('ssh:generateKey', async (projectId) => {
    const target = await sshTarget(projectId);
    const key = await ssh.ensureGitPilotKey();
    return { ...key, host: target.host };
  });
  handle('ssh:openKeyPage', async (projectId) => {
    const target = await sshTarget(projectId);
    await openHttps(ssh.keyPageUrl(target.host));
    return true;
  });
  handle('ssh:test', async (projectId, { identity = null } = {}) => {
    if (identity && !ssh.isAllowedIdentity(identity)) throw new ssh.SshError('Clé SSH inconnue.');
    return ssh.testAccess(await sshTarget(projectId), { identity });
  });
  handle('ssh:use', ({ identity = null } = {}) => {
    if (identity && !ssh.isAllowedIdentity(identity)) throw new ssh.SshError('Clé SSH inconnue.');
    const current = store.getSettings().ssh;
    const identities = identity ? [...new Set([...current.identities, identity])] : current.identities;
    store.updateSettings({ ssh: { enabled: true, identities } });
    applySsh();
    return true;
  });
  handle('ssh:disable', () => {
    store.updateSettings({ ssh: { enabled: false, identities: [] } });
    applySsh();
    return true;
  });
  applySsh();

  /* ----- Programmations ----- */
  handle('schedules:list', () => store.listSchedules());
  handle('schedules:create', (projectId, actionId, runAt) => scheduler.create(projectId, actionId, runAt));
  handle('schedules:cancel', (id) => scheduler.cancel(id));

  handle('runs:list', (projectId) => runner.list(projectId));
  handle('runs:get', (runId) => runner.get(runId));
  handle('runs:cancel', (runId) => runner.cancel(runId));
}

runner.on('output', (payload) => send('runs:output', payload));
runner.on('status', (summary) => {
  if (summary.status !== 'running') {
    store.setActionLastRun(summary.projectId, summary.actionId, {
      status: summary.status,
      exitCode: summary.exitCode,
      startedAt: summary.startedAt,
      endedAt: summary.endedAt,
    });
  }
  send('runs:status', summary);
});

app.on('second-instance', () => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  }
});

app.whenReady().then(() => {
  Menu.setApplicationMenu(process.platform === 'darwin' ? Menu.buildFromTemplate([{ role: 'appMenu' }, { role: 'editMenu' }]) : null);
  store = new Store(path.join(app.getPath('userData'), 'gitpilot-data.json'), {
    defaultShell: findBash() ? 'bash' : (process.platform === 'win32' ? 'powershell' : 'system'),
  });
  accounts = new hosting.Accounts(store);
  scheduler = new Scheduler(store, startAction);
  scheduler.on('changed', () => send('schedules:changed', store.listSchedules()));
  scheduler.start();
  registerIpc();
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('before-quit', () => {
  scheduler?.stop();
  runner.killAll();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
