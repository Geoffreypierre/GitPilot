'use strict';

const crypto = require('crypto');
const { runGit } = require('./git');

const API_TIMEOUT_MS = 15_000;
const MAX_PAGES = 20;
const MAX_TOKEN_LENGTH = 1000;
const REFRESH_MARGIN_MS = 60_000;
const HOST_RE = /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?(?::\d{1,5})?$/;

/*
 * Applications OAuth GitPilot (flux « device » : pas de secret, pas de serveur local).
 * Les identifiants client sont publics : renseignez-les ici ou via les variables
 * d'environnement GITPILOT_GITHUB_CLIENT_ID / GITPILOT_GITLAB_CLIENT_ID.
 * Sans identifiant, seule la connexion par jeton d'accès est proposée.
 */
const GITHUB_CLIENT_ID = '';
const GITLAB_CLIENT_ID = '';

const OAUTH_APPS = {
  'github.com': {
    clientId: process.env.GITPILOT_GITHUB_CLIENT_ID || GITHUB_CLIENT_ID,
    deviceUrl: 'https://github.com/login/device/code',
    tokenUrl: 'https://github.com/login/oauth/access_token',
    scope: 'repo',
  },
  'gitlab.com': {
    clientId: process.env.GITPILOT_GITLAB_CLIENT_ID || GITLAB_CLIENT_ID,
    deviceUrl: 'https://gitlab.com/oauth/authorize_device',
    tokenUrl: 'https://gitlab.com/oauth/token',
    scope: 'api',
  },
};

class HostingError extends Error {
  constructor(message) {
    super(message);
    this.userMessage = message;
  }
}

/* ---------- Hôtes et remotes ---------- */

function normalizeHost(input) {
  const host = String(input || '').trim().toLowerCase().replace(/^[a-z]+:\/\//, '').replace(/\/.*$/, '');
  if (!HOST_RE.test(host)) throw new HostingError('Hôte invalide (ex. gitlab.com ou gitlab.mon-entreprise.fr).');
  return host;
}

/** github.com → GitHub ; tout autre hôte est traité comme une instance GitLab. */
function providerFor(host) {
  return host === 'github.com' ? 'github' : 'gitlab';
}

/** Analyse une URL de remote : HTTPS, ssh:// ou forme courte git@hôte:chemin. */
function parseRemoteUrl(url) {
  const raw = String(url || '').trim();
  let m = raw.match(/^(https?):\/\/(?:[^@/]+@)?([^/]+)\/(.+?)(?:\.git)?\/?$/i);
  if (m) return { scheme: m[1].toLowerCase(), host: m[2].toLowerCase(), path: m[3] };
  // Pour les remotes SSH, l'API reste en HTTPS ; `ssh` décrit la cible de connexion SSH.
  m = raw.match(/^ssh:\/\/(?:([^@/]+)@)?([^/:]+)(?::(\d+))?\/(.+?)(?:\.git)?\/?$/i);
  if (m) {
    const host = m[2].toLowerCase();
    return { scheme: 'https', host, path: m[4], ssh: { user: m[1] || 'git', host, port: m[3] ? Number(m[3]) : null } };
  }
  m = raw.match(/^(?:([^@/\\]+)@)?([^/:\\]{2,}):(?!\/)(.+?)(?:\.git)?\/?$/);
  if (m) {
    const host = m[2].toLowerCase();
    return { scheme: 'https', host, path: m[3], ssh: { user: m[1] || 'git', host, port: null } };
  }
  return null; // chemin local, protocole non géré…
}

/** Remote de référence du projet (origin, sinon le premier) et son hébergeur. */
async function projectRemote(projectPath) {
  const names = (await runGit(projectPath, ['remote'])).split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  if (!names.length) return null;
  const name = names.includes('origin') ? 'origin' : names[0];
  const parsed = parseRemoteUrl((await runGit(projectPath, ['remote', 'get-url', name])).trim());
  return parsed ? { name, ...parsed, provider: providerFor(parsed.host) } : null;
}

/** Page de création de jeton, avec nom et droits pré-remplis. */
function tokenPageUrl(host) {
  return providerFor(host) === 'github'
    ? 'https://github.com/settings/tokens/new?description=GitPilot&scopes=repo'
    : `https://${host}/-/user_settings/personal_access_tokens?name=GitPilot&scopes=api`;
}

function oauthAvailable(host) {
  return Boolean(OAUTH_APPS[host]?.clientId);
}

/* ---------- API ---------- */

function netFetch(url, options) {
  return require('electron').net.fetch(url, options);
}

// GitLab accepte aussi bien un jeton personnel qu'un jeton OAuth en « Bearer ».
function authHeaders(provider, token) {
  const auth = token ? { Authorization: `Bearer ${token}` } : {};
  return provider === 'github'
    ? { ...auth, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' }
    : auth;
}

async function request(url, options, host, fetchFn = netFetch) {
  try {
    return await fetchFn(url, { ...options, signal: AbortSignal.timeout(API_TIMEOUT_MS) });
  } catch (err) {
    throw new HostingError(`Serveur ${host} injoignable (${err.name === 'TimeoutError' ? 'délai dépassé' : err.message}).`);
  }
}

async function apiGet(url, { provider, host, token, notFound, fetchFn }) {
  const res = await request(url, { headers: authHeaders(provider, token) }, host, fetchFn);
  if (res.status === 401) throw new HostingError(`Jeton refusé ou expiré par ${host} : reconnectez le compte.`);
  if (res.status === 403) throw new HostingError(`Accès refusé par ${host} : le jeton n'a pas les droits nécessaires.`);
  if (res.status === 404) throw new HostingError(notFound || `Ressource introuvable sur ${host}.`);
  if (!res.ok) throw new HostingError(`Réponse inattendue de ${host} (HTTP ${res.status}).`);
  return res.json();
}

/** Vérifie un jeton et renvoie le nom du compte associé. */
async function verifyToken(host, token, fetchFn) {
  const provider = providerFor(host);
  const url = provider === 'github' ? 'https://api.github.com/user' : `https://${host}/api/v4/user`;
  const data = await apiGet(url, {
    provider, host, token, fetchFn,
    notFound: `${host} ne répond pas comme un serveur ${provider === 'github' ? 'GitHub' : 'GitLab'}.`,
  });
  return { provider, username: String(data?.login || data?.username || '') };
}

/** Noms des branches protégées du projet distant (un appel par page de 100 branches). */
async function protectedBranches(remote, token, fetchFn) {
  const { provider, host, path, scheme } = remote;
  const names = new Set();
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const url = provider === 'github'
      ? `https://api.github.com/repos/${path.split('/').map(encodeURIComponent).join('/')}/branches?per_page=100&page=${page}`
      : `${scheme}://${host}/api/v4/projects/${encodeURIComponent(path)}/repository/branches?per_page=100&page=${page}`;
    const list = await apiGet(url, {
      provider, host, token, fetchFn,
      notFound: `Projet « ${path} » introuvable sur ${host}, ou le jeton n'y a pas accès.`,
    });
    if (!Array.isArray(list)) break;
    for (const b of list) if (b?.protected && typeof b.name === 'string') names.add(b.name);
    if (list.length < 100) break;
  }
  return [...names];
}

/* ---------- Écriture : merge requests, threads ---------- */

/** Message d'erreur lisible à partir d'une réponse GitLab / GitHub en échec. */
async function apiErrorMessage(res, host, { notFound, scopeHint }) {
  let data = null;
  try { data = await res.json(); } catch { /* corps non JSON */ }
  const details = [];
  const collect = (v) => {
    if (!v) return;
    if (typeof v === 'string') details.push(v);
    else if (Array.isArray(v)) v.forEach(collect);
    else if (typeof v === 'object') {
      if (v.message) collect(v.message);
      else Object.entries(v).forEach(([k, val]) => collect(Array.isArray(val) ? val.map((x) => `${k} ${x}`) : val));
    }
  };
  collect(data?.errors);
  if (!details.length) collect(data?.message || data?.error_description || data?.error);
  const detail = details.join(' — ');
  if (res.status === 401) return `Jeton refusé ou expiré par ${host} : reconnectez le compte.`;
  if (res.status === 403) return `Action refusée par ${host}${scopeHint ? ` (${scopeHint})` : ''}${detail ? ` : ${detail}` : '.'}`;
  if (res.status === 404) return notFound || `Ressource introuvable sur ${host}.`;
  return detail ? `${host} a refusé la demande : ${detail}` : `Réponse inattendue de ${host} (HTTP ${res.status}).`;
}

async function apiSend(method, url, body, { provider, host, token, notFound, scopeHint, fetchFn }) {
  const res = await request(url, {
    method,
    headers: { ...authHeaders(provider, token), 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  }, host, fetchFn);
  if (!res.ok) throw new HostingError(await apiErrorMessage(res, host, { notFound, scopeHint }));
  if (res.status === 204) return null; // pas de contenu (suppression, etc.)
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

const gitlabProject = (remote) => `${remote.scheme}://${remote.host}/api/v4/projects/${encodeURIComponent(remote.path)}`;
const githubRepo = (remote) => `https://api.github.com/repos/${remote.path.split('/').map(encodeURIComponent).join('/')}`;
const scopeHintFor = (remote) => (remote.provider === 'github' ? 'droit « repo » requis' : 'droit « api » requis : reconnectez le compte si besoin');

/** Crée une merge request (GitLab) ou une pull request (GitHub). */
async function createMergeRequest(remote, token, { source, target, title, description = '', draft = false, removeSource = false }, fetchFn) {
  const opts = {
    provider: remote.provider, host: remote.host, token, fetchFn,
    scopeHint: scopeHintFor(remote), notFound: `Projet « ${remote.path} » introuvable sur ${remote.host}, ou le jeton n'y a pas accès.`,
  };
  if (remote.provider === 'github') {
    const pr = await apiSend('POST', `${githubRepo(remote)}/pulls`, { title, head: source, base: target, body: description, draft }, opts);
    return { url: pr.html_url, number: pr.number, kind: 'pull request' };
  }
  const mr = await apiSend('POST', `${gitlabProject(remote)}/merge_requests`, {
    source_branch: source, target_branch: target, title: draft ? `Draft: ${title}` : title, description, remove_source_branch: removeSource,
  }, opts);
  return { url: mr.web_url, number: mr.iid, kind: 'merge request' };
}

/**
 * Threads d'un commit, normalisés : { id, path, side, line, position, canReply, notes: [{ author, body, createdAt }] }.
 * GitLab : discussions (avec réponses). GitHub : commentaires de commit (sans réponses).
 */
async function commitThreads(remote, token, sha, fetchFn) {
  const opts = {
    provider: remote.provider, host: remote.host, token, fetchFn,
    notFound: `Ce commit n'existe pas (encore) sur ${remote.host} : poussez la branche pour pouvoir en discuter.`,
  };
  if (remote.provider === 'github') {
    const list = await apiGet(`${githubRepo(remote)}/commits/${sha}/comments?per_page=100`, opts);
    return (Array.isArray(list) ? list : []).map((c) => ({
      id: String(c.id), path: c.path || null, side: 'new', line: c.line ?? null, position: c.position ?? null, canReply: false,
      notes: [{ author: c.user?.login || '?', body: c.body || '', createdAt: Date.parse(c.created_at) || null }],
    }));
  }
  const list = await apiGet(`${gitlabProject(remote)}/repository/commits/${sha}/discussions?per_page=100`, opts);
  return (Array.isArray(list) ? list : []).map((d) => {
    const pos = d.notes?.[0]?.position;
    const side = pos && pos.new_line == null ? 'old' : 'new';
    return {
      id: String(d.id),
      path: pos ? (side === 'old' ? pos.old_path : pos.new_path) : null,
      side,
      line: pos ? (side === 'old' ? pos.old_line : pos.new_line) : null,
      position: null,
      canReply: true,
      notes: (d.notes || []).filter((n) => !n.system).map((n) => ({
        author: n.author?.name || n.author?.username || '?', body: n.body || '', createdAt: Date.parse(n.created_at) || null,
      })),
    };
  }).filter((t) => t.notes.length);
}

/**
 * Nouveau thread sur un commit, général ou sur une ligne du diff.
 * `anchor` : { path, oldPath, side, oldLine, newLine, position } ; `parent` : SHA du premier parent.
 */
async function createCommitThread(remote, token, sha, { body, anchor = null, parent = null }, fetchFn) {
  const opts = {
    provider: remote.provider, host: remote.host, token, fetchFn, scopeHint: scopeHintFor(remote),
    notFound: `Ce commit n'existe pas (encore) sur ${remote.host} : poussez la branche pour pouvoir en discuter.`,
  };
  if (remote.provider === 'github') {
    const payload = { body };
    if (anchor?.path && anchor.position) Object.assign(payload, { path: anchor.path, position: anchor.position });
    await apiSend('POST', `${githubRepo(remote)}/commits/${sha}/comments`, payload, opts);
    return true;
  }
  const payload = { body };
  if (anchor?.path && parent) {
    payload.position = {
      position_type: 'text', base_sha: parent, start_sha: parent, head_sha: sha,
      new_path: anchor.path, old_path: anchor.oldPath || anchor.path,
    };
    if (anchor.newLine != null) payload.position.new_line = anchor.newLine;
    if (anchor.oldLine != null) payload.position.old_line = anchor.oldLine;
  }
  await apiSend('POST', `${gitlabProject(remote)}/repository/commits/${sha}/discussions`, payload, opts);
  return true;
}

/** Réponse à un thread (GitLab uniquement). */
async function replyCommitThread(remote, token, sha, threadId, body, fetchFn) {
  if (remote.provider !== 'gitlab') throw new HostingError('Les commentaires de commit GitHub ne gèrent pas les réponses.');
  await apiSend('POST', `${gitlabProject(remote)}/repository/commits/${sha}/discussions/${encodeURIComponent(threadId)}/notes`, { body }, {
    provider: remote.provider, host: remote.host, token, fetchFn, scopeHint: scopeHintFor(remote),
  });
  return true;
}

/* ---------- Avatars des auteurs de commits ---------- */

const MAX_AVATAR_BYTES = 200_000;
const avatarCache = new Map(); // `${host}|${email}` -> data URI ou null

/** Télécharge une image et la renvoie en data: URI (la CSP de l'interface interdit les images distantes). */
async function imageDataUri(url, fetchFn = netFetch) {
  let parsed;
  try { parsed = new URL(url); } catch { return null; }
  if (parsed.protocol !== 'https:') return null;
  try {
    const res = await fetchFn(parsed.href, { signal: AbortSignal.timeout(API_TIMEOUT_MS) });
    const type = (res.headers.get('content-type') || '').split(';')[0].trim();
    if (!res.ok || !/^image\/(png|jpe?g|gif|webp)$/.test(type)) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > MAX_AVATAR_BYTES) return null;
    return `data:${type};base64,${buf.toString('base64')}`;
  } catch {
    return null;
  }
}

/** Adresses « noreply » de GitHub : l'identifiant du compte donne directement l'avatar. */
function githubNoreplyAvatar(email) {
  const m = /^(\d+)\+[^@]+@users\.noreply\.github\.com$/i.exec(email);
  return m ? `https://avatars.githubusercontent.com/u/${m[1]}?s=64&v=4` : null;
}

/**
 * Avatars des auteurs (par email) pour un dépôt GitHub ou GitLab.
 * GitHub : correspondance email ↔ compte lue dans les commits de la branche sur GitHub.
 * GitLab : point d'API /avatar?email=…
 */
async function authorAvatars(remote, token, { branch = null, emails = [] } = {}, fetchFn = netFetch) {
  const { provider, host, path, scheme } = remote;
  const wanted = [...new Set(emails.filter((e) => typeof e === 'string' && e.includes('@')))].slice(0, 100);
  const result = {};
  const missing = [];
  for (const email of wanted) {
    const key = `${host}|${email.toLowerCase()}`;
    if (avatarCache.has(key)) result[email] = avatarCache.get(key);
    else missing.push(email);
  }
  if (!missing.length) return result;

  const urls = new Map(); // email -> URL de l'image
  if (provider === 'github') {
    for (const email of missing) {
      const direct = githubNoreplyAvatar(email);
      if (direct) urls.set(email, direct);
    }
    if (missing.some((e) => !urls.has(e))) {
      const repo = path.split('/').map(encodeURIComponent).join('/');
      const base = `https://api.github.com/repos/${repo}/commits?per_page=100`;
      let list = [];
      try {
        list = await apiGet(branch ? `${base}&sha=${encodeURIComponent(branch)}` : base, { provider, host, token, fetchFn });
      } catch {
        try { list = await apiGet(base, { provider, host, token, fetchFn }); } catch { list = []; }
      }
      for (const item of Array.isArray(list) ? list : []) {
        const email = item?.commit?.author?.email;
        const avatar = item?.author?.avatar_url;
        if (email && avatar) {
          const match = missing.find((e) => e.toLowerCase() === email.toLowerCase());
          if (match && !urls.has(match)) urls.set(match, `${avatar}${avatar.includes('?') ? '&' : '?'}s=64`);
        }
      }
    }
  } else {
    await Promise.all(missing.map(async (email) => {
      try {
        const data = await apiGet(`${scheme}://${host}/api/v4/avatar?email=${encodeURIComponent(email)}&size=64`, { provider, host, token, fetchFn });
        if (data?.avatar_url) urls.set(email, data.avatar_url);
      } catch { /* pas d'avatar */ }
    }));
  }

  await Promise.all(missing.map(async (email) => {
    const uri = urls.has(email) ? await imageDataUri(urls.get(email), fetchFn) : null;
    avatarCache.set(`${host}|${email.toLowerCase()}`, uri);
    result[email] = uri;
  }));
  return result;
}

/* ---------- OAuth (flux device, RFC 8628) ---------- */

async function postForm(url, params, host, fetchFn) {
  const res = await request(url, {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params).toString(),
  }, host, fetchFn);
  let data = null;
  try { data = await res.json(); } catch { /* corps non JSON */ }
  return { status: res.status, data: data || {} };
}

function tokensFrom(data) {
  return {
    token: String(data.access_token),
    refreshToken: data.refresh_token ? String(data.refresh_token) : null,
    expiresAt: Number(data.expires_in) > 0 ? Date.now() + Number(data.expires_in) * 1000 : null,
  };
}

async function startDeviceFlow(host, fetchFn) {
  const app = OAUTH_APPS[host];
  if (!app?.clientId) throw new HostingError(`La connexion OAuth n'est pas configurée pour ${host}. Utilisez un jeton d'accès.`);
  const { status, data } = await postForm(app.deviceUrl, { client_id: app.clientId, scope: app.scope }, host, fetchFn);
  if (status >= 400 || !data.device_code || !data.user_code) {
    throw new HostingError(`${host} a refusé la demande de connexion${data.error_description ? ` : ${data.error_description}` : data.error ? ` (${data.error})` : '.'}`);
  }
  return {
    deviceCode: String(data.device_code),
    userCode: String(data.user_code),
    verificationUri: String(data.verification_uri),
    verificationUriComplete: data.verification_uri_complete ? String(data.verification_uri_complete) : null,
    interval: Math.max(Number(data.interval) || 5, 1),
    expiresAt: Date.now() + (Number(data.expires_in) || 900) * 1000,
  };
}

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(new HostingError('Connexion annulée.')); return; }
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => { clearTimeout(t); reject(new HostingError('Connexion annulée.')); }, { once: true });
  });
}

/** Attend que l'utilisateur autorise GitPilot dans son navigateur. */
async function pollDeviceToken(host, flow, { signal, fetchFn } = {}) {
  const app = OAUTH_APPS[host];
  let interval = flow.interval;
  while (Date.now() < flow.expiresAt) {
    await sleep(interval * 1000, signal);
    const { data } = await postForm(app.tokenUrl, {
      client_id: app.clientId,
      device_code: flow.deviceCode,
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
    }, host, fetchFn);
    if (data.access_token) return tokensFrom(data);
    if (data.error === 'authorization_pending') continue;
    if (data.error === 'slow_down') { interval = Number(data.interval) || interval + 5; continue; }
    if (data.error === 'access_denied') throw new HostingError('Autorisation refusée dans le navigateur.');
    if (data.error === 'expired_token') break;
    throw new HostingError(`Connexion impossible (${data.error_description || data.error || 'réponse inattendue'}).`);
  }
  throw new HostingError('Le code a expiré avant l’autorisation. Recommencez.');
}

async function refreshOAuthToken(host, refreshToken, fetchFn) {
  const app = OAUTH_APPS[host];
  if (!app?.clientId) throw new HostingError(`Session ${host} expirée : reconnectez le compte.`);
  const { data } = await postForm(app.tokenUrl, {
    client_id: app.clientId,
    refresh_token: refreshToken,
    grant_type: 'refresh_token',
  }, host, fetchFn);
  if (!data.access_token) throw new HostingError(`Session ${host} expirée : reconnectez le compte.`);
  return tokensFrom(data);
}

/* ---------- Comptes ---------- */

/**
 * Comptes par hôte. Le secret (jeton, éventuel jeton de renouvellement) est chiffré
 * avec safeStorage et enregistré dans le store ; sans trousseau sécurisé (Linux sans
 * GNOME Keyring / KWallet), il n'est gardé qu'en mémoire, jusqu'à la fermeture.
 */
class Accounts {
  constructor(store) {
    this.store = store;
    this.session = new Map(); // `${host}|${username}` -> { host, provider, username, method, secret }
    this.flows = new Map(); // flowId -> { host, controller, promise }
  }

  canPersist() {
    const { safeStorage } = require('electron');
    if (!safeStorage.isEncryptionAvailable()) return false;
    if (process.platform === 'linux' && safeStorage.getSelectedStorageBackend?.() === 'basic_text') return false;
    return true;
  }

  /** Tous les comptes (enregistrés et de session) d'un hôte, ou de tous les hôtes. */
  all(host = null) {
    const saved = this.store.listAccounts().map((a) => ({ ...a, persistent: true }));
    const temp = [...this.session.values()].map((a) => ({ ...a, persistent: false }));
    return [...saved, ...temp].filter((a) => !host || a.host === host);
  }

  /** Nom du compte actif de l'hôte : celui choisi, sinon le premier connecté. */
  activeUsername(host) {
    const accounts = this.all(host);
    const chosen = this.store.getActiveAccount(host);
    return accounts.find((a) => a.username === chosen)?.username || accounts[0]?.username || null;
  }

  list() {
    const active = new Map();
    return this.all().map((a) => {
      if (!active.has(a.host)) active.set(a.host, this.activeUsername(a.host));
      return {
        host: a.host, provider: a.provider, username: a.username, method: a.method || 'token',
        persistent: a.persistent, active: active.get(a.host) === a.username,
      };
    }).sort((a, b) => a.host.localeCompare(b.host) || Number(b.active) - Number(a.active) || a.username.localeCompare(b.username));
  }

  setActive(host, username) {
    if (!this.all(host).some((a) => a.username === username)) throw new HostingError('Compte inconnu pour ce serveur.');
    this.store.setActiveAccount(host, username);
  }

  /** Lit le compte actif de l'hôte et son secret déchiffré, ou null. */
  read(host) {
    const username = this.activeUsername(host);
    if (!username) return null;
    const key = `${host}|${username}`;
    if (this.session.has(key)) return this.session.get(key);
    const saved = this.store.getAccount(host, username);
    if (!saved) return null;
    try {
      const plain = require('electron').safeStorage.decryptString(Buffer.from(saved.secret || saved.token, 'base64'));
      const secret = plain.startsWith('{') ? JSON.parse(plain) : { token: plain };
      return { ...saved, secret };
    } catch {
      return null; // secret illisible (trousseau changé) : il faudra se reconnecter
    }
  }

  /** Enregistre le compte et le rend actif pour son hôte. */
  save({ host, provider, username, method, secret }) {
    this.session.delete(`${host}|${username}`);
    this.store.removeAccount(host, username);
    const persistent = this.canPersist();
    if (persistent) {
      const encrypted = require('electron').safeStorage.encryptString(JSON.stringify(secret)).toString('base64');
      this.store.setAccount({ host, provider, username, method, secret: encrypted });
    } else {
      this.session.set(`${host}|${username}`, { host, provider, username, method, secret });
    }
    this.store.setActiveAccount(host, username);
    return { host, provider, username, method, persistent, active: true };
  }

  /** Jeton utilisable pour l'hôte (renouvelé si besoin), ou null si aucun compte. */
  async getToken(host) {
    const account = this.read(host);
    if (!account) return null;
    const { secret } = account;
    if (secret.refreshToken && secret.expiresAt && Date.now() > secret.expiresAt - REFRESH_MARGIN_MS) {
      const fresh = await refreshOAuthToken(host, secret.refreshToken);
      this.save({ ...account, secret: fresh });
      return fresh.token;
    }
    return secret.token;
  }

  async connectToken(hostInput, tokenInput) {
    const host = normalizeHost(hostInput);
    const token = String(tokenInput || '').trim();
    if (!token) throw new HostingError("Collez le jeton d'accès.");
    if (token.length > MAX_TOKEN_LENGTH || /\s/.test(token)) throw new HostingError('Jeton invalide.');
    const { provider, username } = await verifyToken(host, token);
    return this.save({ host, provider, username, method: 'token', secret: { token } });
  }

  /** Démarre une connexion OAuth ; l'attente se fait ensuite avec oauthWait(flowId). */
  async oauthStart(hostInput) {
    const host = normalizeHost(hostInput);
    const flow = await startDeviceFlow(host);
    const id = crypto.randomUUID();
    const controller = new AbortController();
    const promise = (async () => {
      const tokens = await pollDeviceToken(host, flow, { signal: controller.signal });
      const { provider, username } = await verifyToken(host, tokens.token);
      return this.save({ host, provider, username, method: 'oauth', secret: tokens });
    })();
    promise.catch(() => {}).finally(() => this.flows.delete(id));
    this.flows.set(id, { host, controller, promise });
    return {
      flowId: id,
      host,
      userCode: flow.userCode,
      verificationUri: flow.verificationUriComplete || flow.verificationUri,
      expiresAt: flow.expiresAt,
    };
  }

  oauthWait(flowId) {
    const flow = this.flows.get(flowId);
    if (!flow) throw new HostingError('Connexion introuvable ou déjà terminée.');
    return flow.promise;
  }

  oauthCancel(flowId) {
    this.flows.get(flowId)?.controller.abort();
    return true;
  }

  /** Déconnecte un compte (ou tous ceux de l'hôte) ; un autre compte de l'hôte devient actif. */
  remove(host, username) {
    for (const key of [...this.session.keys()]) {
      if (key.startsWith(`${host}|`) && (username === undefined || key === `${host}|${username}`)) this.session.delete(key);
    }
    this.store.removeAccount(host, username);
    if (username === undefined || this.store.getActiveAccount(host) === username) {
      this.store.setActiveAccount(host, this.all(host)[0]?.username || null);
    }
  }
}

module.exports = {
  HostingError, Accounts, normalizeHost, providerFor, parseRemoteUrl, projectRemote, tokenPageUrl, oauthAvailable,
  verifyToken, protectedBranches, authorAvatars, createMergeRequest, commitThreads, createCommitThread, replyCommitThread, startDeviceFlow, pollDeviceToken, refreshOAuthToken,
  // Briques réutilisées par forge.js (merge requests)
  apiGet, apiSend, gitlabProject, githubRepo, scopeHintFor,
};
