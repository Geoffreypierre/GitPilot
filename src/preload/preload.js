'use strict';

const { contextBridge, ipcRenderer } = require('electron');

async function call(channel, ...args) {
  const res = await ipcRenderer.invoke(channel, ...args);
  if (!res || !res.ok) throw new Error(res?.error || 'Erreur inconnue.');
  return res.data;
}

function subscribe(channel, cb) {
  const listener = (_event, payload) => cb(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

contextBridge.exposeInMainWorld('gitpilot', {
  app: {
    info: () => call('app:info'),
    browse: () => call('dialog:browse'),
  },
  settings: {
    get: () => call('settings:get'),
    update: (patch) => call('settings:update', patch),
  },
  projects: {
    list: () => call('projects:list'),
    add: (input) => call('projects:add', input),
    remove: (id) => call('projects:remove', id),
    summary: (id) => call('projects:summary', id),
    branches: (id, opts) => call('projects:branches', id, opts),
    openFolder: (id) => call('projects:openFolder', id),
  },
  actions: {
    create: (projectId, input) => call('actions:create', projectId, input),
    update: (projectId, actionId, input) => call('actions:update', projectId, actionId, input),
    remove: (projectId, actionId) => call('actions:remove', projectId, actionId),
    run: (projectId, actionId) => call('actions:run', projectId, actionId),
  },
  runs: {
    list: (projectId) => call('runs:list', projectId),
    get: (runId) => call('runs:get', runId),
    cancel: (runId) => call('runs:cancel', runId),
    onOutput: (cb) => subscribe('runs:output', cb),
    onStatus: (cb) => subscribe('runs:status', cb),
  },
});
