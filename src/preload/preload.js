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
    openUrl: (url) => call('app:openUrl', url),
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
    deleteBranch: (id, opts) => call('projects:deleteBranch', id, opts),
    protection: (id, opts) => call('projects:protection', id, opts),
    openFolder: (id) => call('projects:openFolder', id),
  },
  actions: {
    create: (projectId, input) => call('actions:create', projectId, input),
    update: (projectId, actionId, input) => call('actions:update', projectId, actionId, input),
    remove: (projectId, actionId) => call('actions:remove', projectId, actionId),
    run: (projectId, actionId) => call('actions:run', projectId, actionId),
    export: (projectId, actionIds) => call('actions:export', projectId, actionIds),
    readImport: () => call('actions:readImport'),
    import: (projectId, actions, options) => call('actions:import', projectId, actions, options),
    copy: (sourceProjectId, actionIds, targetProjectIds, options) => call('actions:copy', sourceProjectId, actionIds, targetProjectIds, options),
  },
  accounts: {
    list: () => call('accounts:list'),
    connect: (input) => call('accounts:connect', input),
    oauthAvailable: (host) => call('accounts:oauthAvailable', host),
    oauthStart: (host) => call('accounts:oauthStart', host),
    oauthOpen: (flowId) => call('accounts:oauthOpen', flowId),
    oauthWait: (flowId) => call('accounts:oauthWait', flowId),
    oauthCancel: (flowId) => call('accounts:oauthCancel', flowId),
    remove: (host, username) => call('accounts:remove', host, username),
    setActive: (host, username) => call('accounts:setActive', host, username),
    openTokenPage: (host) => call('accounts:openTokenPage', host),
  },
  git: {
    log: (projectId, opts) => call('git:log', projectId, opts),
    commit: (projectId, sha) => call('git:commit', projectId, sha),
    avatars: (projectId, opts) => call('git:avatars', projectId, opts),
    status: (projectId) => call('git:status', projectId),
    checkout: (projectId, opts) => call('git:checkout', projectId, opts),
  },
  hosting: {
    mergeRequestInfo: (projectId, ref) => call('hosting:mergeRequestInfo', projectId, ref),
    createMergeRequest: (projectId, input) => call('hosting:createMergeRequest', projectId, input),
    threads: (projectId, sha) => call('hosting:threads', projectId, sha),
    createThread: (projectId, sha, input) => call('hosting:createThread', projectId, sha, input),
    replyThread: (projectId, sha, threadId, body) => call('hosting:replyThread', projectId, sha, threadId, body),
  },
  mr: {
    list: (projectId, opts) => call('mr:list', projectId, opts),
    get: (projectId, number) => call('mr:get', projectId, number),
    targets: (projectId) => call('mr:targets', projectId),
    update: (projectId, number, changes) => call('mr:update', projectId, number, changes),
    merge: (projectId, number, opts) => call('mr:merge', projectId, number, opts),
    commits: (projectId, number) => call('mr:commits', projectId, number),
    changes: (projectId, number) => call('mr:changes', projectId, number),
    threads: (projectId, number) => call('mr:threads', projectId, number),
    createThread: (projectId, number, input) => call('mr:createThread', projectId, number, input),
    replyThread: (projectId, number, threadId, body) => call('mr:replyThread', projectId, number, threadId, body),
    resolveThread: (projectId, number, threadId, resolved) => call('mr:resolveThread', projectId, number, threadId, resolved),
  },
  ssh: {
    status: () => call('ssh:status'),
    detect: (projectId) => call('ssh:detect', projectId),
    generateKey: (projectId) => call('ssh:generateKey', projectId),
    openKeyPage: (projectId) => call('ssh:openKeyPage', projectId),
    test: (projectId, opts) => call('ssh:test', projectId, opts),
    use: (opts) => call('ssh:use', opts),
    disable: () => call('ssh:disable'),
  },
  schedules: {
    list: () => call('schedules:list'),
    create: (projectId, actionId, runAt) => call('schedules:create', projectId, actionId, runAt),
    cancel: (id) => call('schedules:cancel', id),
    onChanged: (cb) => subscribe('schedules:changed', cb),
  },
  runs: {
    list: (projectId) => call('runs:list', projectId),
    get: (runId) => call('runs:get', runId),
    cancel: (runId) => call('runs:cancel', runId),
    onOutput: (cb) => subscribe('runs:output', cb),
    onStatus: (cb) => subscribe('runs:status', cb),
  },
});
