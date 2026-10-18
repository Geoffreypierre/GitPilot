'use strict';

const { app, BrowserWindow, ipcMain, dialog, shell, Menu } = require('electron');
const path = require('path');
const os = require('os');
const { Store } = require('./src/main/store');
const git = require('./src/main/git');
const { Runner, availableShells, findBash } = require('./src/main/runner');

let mainWindow = null;
let store;
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

async function doFetch(project) {
  const result = await git.fetchAll(project.path);
  fetchState.set(project.id, result);
  return result;
}

function registerIpc() {
  /* ----- Application ----- */
  handle('app:info', async () => {
    let user = 'Utilisateur';
    try { user = os.userInfo().username || user; } catch { /* ignore */ }
    return {
      user,
      platform: process.platform,
      version: app.getVersion(),
      gitVersion: await git.gitVersion(),
      dataFile: store.file,
      shells: availableShells(),
    };
  });

  handle('settings:get', () => store.getSettings());
  handle('settings:update', (patch) => store.updateSettings(patch));

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
    fetchState.delete(id);
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
    return true;
  });

  // Le renderer ne transmet que des identifiants : le script exécuté est toujours
  // celui enregistré par l'utilisateur, dans le dossier du projet concerné.
  handle('actions:run', async (projectId, actionId) => {
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
    });
  });

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
  registerIpc();
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('before-quit', () => runner.killAll());

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
