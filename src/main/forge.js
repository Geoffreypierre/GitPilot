'use strict';

/**
 * Merge requests GitLab et pull requests GitHub : liste, détail, modification, fusion,
 * commits, changements et threads. Les données sont normalisées pour l'interface :
 *   MR     { number, title, state: opened|merged|closed, draft, author, source, target, … }
 *   thread { id, path, side: new|old, line, canReply, resolvable, resolved, notes: [{ author, body, createdAt }] }
 */
const { HostingError, apiGet, apiSend, gitlabProject, githubRepo, scopeHintFor } = require('./hosting');
const { parsePatch } = require('./history');

const PAGE_SIZE = 30;
const STATES = ['opened', 'merged', 'closed', 'all'];
const DRAFT_PREFIX_RE = /^\s*(\[draft\]|\(draft\)|draft:|draft\s+-\s+|\[wip\]|wip:)\s*/i;

const time = (v) => (v ? Date.parse(v) || null : null);
const isGitHub = (remote) => remote.provider === 'github';

function num(value) {
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) throw new HostingError('Numéro de merge request invalide.');
  return n;
}

function opts(remote, token, fetchFn, extra = {}) {
  return {
    provider: remote.provider, host: remote.host, token, fetchFn, scopeHint: scopeHintFor(remote),
    notFound: `${isGitHub(remote) ? 'Pull request' : 'Merge request'} introuvable sur ${remote.host}.`,
    ...extra,
  };
}

/** Lit toutes les pages (100 éléments) d'une liste, dans la limite de `maxPages`. */
async function allPages(url, o, maxPages = 10) {
  const out = [];
  for (let page = 1; page <= maxPages; page += 1) {
    const list = await apiGet(`${url}${url.includes('?') ? '&' : '?'}per_page=100&page=${page}`, o);
    if (!Array.isArray(list)) break;
    out.push(...list);
    if (list.length < 100) break;
  }
  return out;
}

/* ---------- Normalisation ---------- */

function fromGitlab(mr) {
  return {
    number: mr.iid,
    title: mr.title || '',
    state: mr.state === 'merged' || mr.state === 'closed' ? mr.state : 'opened',
    draft: Boolean(mr.draft ?? mr.work_in_progress),
    author: mr.author?.name || mr.author?.username || '?',
    source: mr.source_branch,
    target: mr.target_branch,
    createdAt: time(mr.created_at),
    updatedAt: time(mr.updated_at),
    comments: mr.user_notes_count ?? null,
    url: mr.web_url,
  };
}

function fromGithub(pr) {
  return {
    number: pr.number,
    title: pr.title || '',
    state: pr.merged_at ? 'merged' : pr.state === 'open' ? 'opened' : 'closed',
    draft: Boolean(pr.draft),
    author: pr.user?.login || '?',
    source: pr.head?.ref,
    target: pr.base?.ref,
    createdAt: time(pr.created_at),
    updatedAt: time(pr.updated_at),
    comments: pr.comments != null ? pr.comments + (pr.review_comments || 0) : null,
    url: pr.html_url,
  };
}

const GITLAB_MERGE_STATUS = {
  mergeable: [true, 'Prête à être fusionnée', 'success'],
  conflict: [false, 'Conflits à résoudre avant la fusion', 'danger'],
  broken_status: [false, 'Fusion impossible (conflits ou branche invalide)', 'danger'],
  draft_status: [false, 'Brouillon : marquez-la comme prête pour pouvoir la fusionner', 'warning'],
  discussions_not_resolved: [false, 'Des threads doivent être résolus avant la fusion', 'warning'],
  not_approved: [false, 'Approbation requise avant la fusion', 'warning'],
  requested_changes: [false, 'Des modifications ont été demandées', 'warning'],
  ci_must_pass: [false, 'Le pipeline doit réussir avant la fusion', 'warning'],
  ci_still_running: [false, 'Pipeline en cours', 'info'],
  need_rebase: [false, 'Rebase nécessaire sur la branche cible', 'warning'],
  blocked_status: [false, 'Bloquée par une autre merge request', 'warning'],
  not_open: [false, 'Merge request non ouverte', 'info'],
  checking: [false, 'Vérification de la fusion en cours…', 'info'],
  unchecked: [false, 'Vérification de la fusion en cours…', 'info'],
  preparing: [false, 'Préparation en cours…', 'info'],
};

function gitlabMergeState(mr) {
  const entry = GITLAB_MERGE_STATUS[mr.detailed_merge_status]
    || (mr.merge_status === 'can_be_merged' ? GITLAB_MERGE_STATUS.mergeable : null)
    || (mr.merge_status === 'cannot_be_merged' ? GITLAB_MERGE_STATUS.conflict : null)
    || [false, 'État de fusion inconnu', 'info'];
  return { canMerge: entry[0], label: entry[1], tone: entry[2] };
}

function githubMergeState(pr) {
  if (pr.draft) return { canMerge: false, label: 'Brouillon : marquez-la comme prête pour pouvoir la fusionner', tone: 'warning' };
  if (pr.mergeable === null) return { canMerge: false, label: 'Vérification de la fusion en cours…', tone: 'info' };
  switch (pr.mergeable_state) {
    case 'clean':
    case 'has_hooks': return { canMerge: true, label: 'Prête à être fusionnée', tone: 'success' };
    case 'unstable': return { canMerge: true, label: 'Des vérifications échouent, mais la fusion est possible', tone: 'warning' };
    case 'behind': return { canMerge: Boolean(pr.mergeable), label: 'La branche est en retard sur la branche cible', tone: 'warning' };
    case 'dirty': return { canMerge: false, label: 'Conflits à résoudre avant la fusion', tone: 'danger' };
    case 'blocked': return { canMerge: false, label: 'Bloquée : revue ou vérifications requises', tone: 'warning' };
    default: return { canMerge: Boolean(pr.mergeable), label: pr.mergeable ? 'Prête à être fusionnée' : 'Fusion impossible', tone: pr.mergeable ? 'success' : 'danger' };
  }
}

/* ---------- Liste et détail ---------- */

async function listMergeRequests(remote, token, { state = 'opened', page = 1 } = {}, fetchFn) {
  if (!STATES.includes(state)) throw new HostingError('Filtre inconnu.');
  const p = Math.max(1, Math.floor(Number(page) || 1));
  const o = opts(remote, token, fetchFn, { notFound: `Projet « ${remote.path} » introuvable sur ${remote.host}, ou le jeton n'y a pas accès.` });
  if (isGitHub(remote)) {
    const ghState = state === 'opened' ? 'open' : state === 'all' ? 'all' : 'closed';
    const list = await apiGet(`${githubRepo(remote)}/pulls?state=${ghState}&sort=updated&direction=desc&per_page=${PAGE_SIZE}&page=${p}`, o);
    let items = (Array.isArray(list) ? list : []).map(fromGithub);
    if (state === 'merged' || state === 'closed') items = items.filter((i) => i.state === state);
    return { items, hasMore: Array.isArray(list) && list.length === PAGE_SIZE };
  }
  const list = await apiGet(`${gitlabProject(remote)}/merge_requests?state=${state}&order_by=updated_at&sort=desc&per_page=${PAGE_SIZE}&page=${p}`, o);
  return { items: (Array.isArray(list) ? list : []).map(fromGitlab), hasMore: Array.isArray(list) && list.length === PAGE_SIZE };
}

async function getMergeRequest(remote, token, number, fetchFn) {
  const n = num(number);
  const o = opts(remote, token, fetchFn);
  if (isGitHub(remote)) {
    const pr = await apiGet(`${githubRepo(remote)}/pulls/${n}`, o);
    return {
      ...fromGithub(pr),
      description: pr.body || '',
      headSha: pr.head?.sha || null,
      baseSha: pr.base?.sha || null,
      startSha: null,
      nodeId: pr.node_id,
      sameRepo: pr.head?.repo?.full_name === pr.base?.repo?.full_name,
      merge: githubMergeState(pr),
      removeSource: false,
      squash: false,
      mergedBy: pr.merged_by?.login || null,
      mergedAt: time(pr.merged_at),
      closedAt: time(pr.closed_at),
      commitCount: pr.commits ?? null,
      changeCount: pr.changed_files ?? null,
      canResolve: false,
    };
  }
  const mr = await apiGet(`${gitlabProject(remote)}/merge_requests/${n}`, o);
  return {
    ...fromGitlab(mr),
    description: mr.description || '',
    headSha: mr.diff_refs?.head_sha || mr.sha || null,
    baseSha: mr.diff_refs?.base_sha || null,
    startSha: mr.diff_refs?.start_sha || null,
    sameRepo: mr.source_project_id === mr.target_project_id,
    merge: gitlabMergeState(mr),
    removeSource: Boolean(mr.force_remove_source_branch ?? mr.should_remove_source_branch),
    squash: Boolean(mr.squash),
    mergedBy: mr.merged_by?.name || mr.merge_user?.name || null,
    mergedAt: time(mr.merged_at),
    closedAt: time(mr.closed_at),
    commitCount: null,
    changeCount: mr.changes_count != null ? Number.parseInt(mr.changes_count, 10) || null : null,
    canResolve: true,
  };
}

/* ---------- Modification et fusion ---------- */

async function githubGraphql(remote, token, query, variables, fetchFn) {
  const res = await apiSend('POST', 'https://api.github.com/graphql', { query, variables }, opts(remote, token, fetchFn));
  if (res?.errors?.length) throw new HostingError(`github.com a refusé la demande : ${res.errors.map((e) => e.message).join(' — ')}`);
  return res?.data;
}

/**
 * Modifie une MR : { title, description, target, draft, state: 'close' | 'reopen' }.
 * Seuls les champs fournis sont modifiés.
 */
async function updateMergeRequest(remote, token, number, changes, fetchFn) {
  const n = num(number);
  const o = opts(remote, token, fetchFn);
  const has = (k) => changes[k] !== undefined && changes[k] !== null;

  if (isGitHub(remote)) {
    const body = {};
    if (has('title')) body.title = changes.title;
    if (has('description')) body.body = changes.description;
    if (has('target')) body.base = changes.target;
    if (has('state')) body.state = changes.state === 'close' ? 'closed' : 'open';
    if (Object.keys(body).length) await apiSend('PATCH', `${githubRepo(remote)}/pulls/${n}`, body, o);
    if (has('draft')) {
      const pr = await apiGet(`${githubRepo(remote)}/pulls/${n}`, o);
      if (Boolean(pr.draft) !== changes.draft) {
        const mutation = changes.draft
          ? 'mutation($id: ID!) { convertPullRequestToDraft(input: { pullRequestId: $id }) { clientMutationId } }'
          : 'mutation($id: ID!) { markPullRequestReadyForReview(input: { pullRequestId: $id }) { clientMutationId } }';
        await githubGraphql(remote, token, mutation, { id: pr.node_id }, fetchFn);
      }
    }
    return true;
  }

  const body = {};
  if (has('description')) body.description = changes.description;
  if (has('target')) body.target_branch = changes.target;
  if (has('state')) body.state_event = changes.state === 'close' ? 'close' : 'reopen';
  if (has('title') || has('draft')) {
    // GitLab : le statut brouillon est porté par le préfixe « Draft: » du titre.
    let title = changes.title;
    let draft = changes.draft;
    if (!has('title') || !has('draft')) {
      const mr = await apiGet(`${gitlabProject(remote)}/merge_requests/${n}`, o);
      if (!has('title')) title = mr.title;
      if (!has('draft')) draft = Boolean(mr.draft ?? mr.work_in_progress);
    }
    const bare = String(title).replace(DRAFT_PREFIX_RE, '');
    body.title = draft ? `Draft: ${bare}` : bare;
  }
  if (Object.keys(body).length) await apiSend('PUT', `${gitlabProject(remote)}/merge_requests/${n}`, body, o);
  return true;
}

async function mergeMergeRequest(remote, token, number, { squash = false, removeSource = false } = {}, fetchFn) {
  const n = num(number);
  const o = opts(remote, token, fetchFn);
  if (isGitHub(remote)) {
    const pr = await apiGet(`${githubRepo(remote)}/pulls/${n}`, o);
    await apiSend('PUT', `${githubRepo(remote)}/pulls/${n}/merge`, { merge_method: squash ? 'squash' : 'merge' }, o);
    let sourceDeleted = false;
    if (removeSource && pr.head?.repo?.full_name === pr.base?.repo?.full_name) {
      await apiSend('DELETE', `${githubRepo(remote)}/git/refs/heads/${pr.head.ref.split('/').map(encodeURIComponent).join('/')}`, undefined, o);
      sourceDeleted = true;
    }
    return { merged: true, sourceDeleted };
  }
  await apiSend('PUT', `${gitlabProject(remote)}/merge_requests/${n}/merge`, { squash, should_remove_source_branch: removeSource }, o);
  return { merged: true, sourceDeleted: removeSource };
}

/* ---------- Commits et changements ---------- */

async function mergeRequestCommits(remote, token, number, fetchFn) {
  const n = num(number);
  const o = opts(remote, token, fetchFn);
  if (isGitHub(remote)) {
    const list = await allPages(`${githubRepo(remote)}/pulls/${n}/commits`, o, 3);
    return list.map((c) => ({
      sha: c.sha, shortSha: c.sha.slice(0, 8), subject: (c.commit?.message || '').split('\n')[0],
      author: c.commit?.author?.name || c.author?.login || '?', email: c.commit?.author?.email || null, date: time(c.commit?.author?.date),
    })).reverse(); // du plus récent au plus ancien, comme GitLab
  }
  const list = await allPages(`${gitlabProject(remote)}/merge_requests/${n}/commits`, o, 5);
  return list.map((c) => ({
    sha: c.id, shortSha: c.short_id || c.id.slice(0, 8), subject: c.title || '',
    author: c.author_name || '?', email: c.author_email || null, date: time(c.authored_date || c.created_at),
  }));
}

/** Rassemble des diffs par fichier (format API) en un patch unique, puis le découpe comme `git show`. */
function filesToDiff(entries) {
  const text = entries.map((f) => {
    const head = [`diff --git a/${f.oldPath} b/${f.newPath}`];
    if (f.added) head.push('new file mode 100644');
    if (f.deleted) head.push('deleted file mode 100644');
    if (f.renamed && f.oldPath !== f.newPath) head.push(`rename from ${f.oldPath}`, `rename to ${f.newPath}`);
    const diff = f.diff ? `${f.diff.replace(/\n$/, '')}\n` : '';
    return `${head.join('\n')}\n${diff}`;
  }).join('');
  const parsed = parsePatch(text);
  parsed.files.forEach((file, i) => { if (entries[i] && !entries[i].diff) file.unavailable = true; });
  return {
    files: parsed.files,
    truncated: parsed.truncated,
    stats: {
      files: parsed.files.length,
      additions: parsed.files.reduce((s, f) => s + f.additions, 0),
      deletions: parsed.files.reduce((s, f) => s + f.deletions, 0),
    },
  };
}

async function mergeRequestChanges(remote, token, number, fetchFn) {
  const n = num(number);
  const o = opts(remote, token, fetchFn);
  if (isGitHub(remote)) {
    const list = await allPages(`${githubRepo(remote)}/pulls/${n}/files`, o, 30);
    return filesToDiff(list.map((f) => ({
      oldPath: f.previous_filename || f.filename, newPath: f.filename,
      added: f.status === 'added', deleted: f.status === 'removed', renamed: f.status === 'renamed', diff: f.patch || '',
    })));
  }
  let list;
  try {
    list = await allPages(`${gitlabProject(remote)}/merge_requests/${n}/diffs`, o, 30);
  } catch {
    // Instances GitLab antérieures à 15.7 : point d'API /changes.
    list = (await apiGet(`${gitlabProject(remote)}/merge_requests/${n}/changes`, o))?.changes || [];
  }
  return filesToDiff(list.map((f) => ({
    oldPath: f.old_path, newPath: f.new_path, added: f.new_file, deleted: f.deleted_file, renamed: f.renamed_file, diff: f.diff || '',
  })));
}

/* ---------- Threads ---------- */

const noteOf = (author, body, createdAt) => ({ author: author || '?', body: body || '', createdAt: time(createdAt) });

async function mergeRequestThreads(remote, token, number, fetchFn) {
  const n = num(number);
  const o = opts(remote, token, fetchFn);
  if (isGitHub(remote)) {
    const [issueComments, reviewComments] = await Promise.all([
      allPages(`${githubRepo(remote)}/issues/${n}/comments`, o),
      allPages(`${githubRepo(remote)}/pulls/${n}/comments`, o),
    ]);
    const threads = issueComments.map((c) => ({
      id: `issue-${c.id}`, path: null, side: 'new', line: null, canReply: false, resolvable: false, resolved: false,
      notes: [noteOf(c.user?.login, c.body, c.created_at)],
    }));
    const roots = new Map();
    const sorted = [...reviewComments].sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at));
    for (const c of sorted) {
      const root = c.in_reply_to_id && roots.get(String(c.in_reply_to_id));
      if (root) { root.notes.push(noteOf(c.user?.login, c.body, c.created_at)); continue; }
      const line = c.line ?? c.original_line ?? null;
      const thread = {
        id: String(c.id), path: c.path || null, side: c.side === 'LEFT' ? 'old' : 'new', line,
        outdated: c.line == null, canReply: true, resolvable: false, resolved: false,
        notes: [noteOf(c.user?.login, c.body, c.created_at)],
      };
      roots.set(String(c.id), thread);
      threads.push(thread);
    }
    return threads.sort((a, b) => (a.notes[0].createdAt || 0) - (b.notes[0].createdAt || 0));
  }
  const list = await allPages(`${gitlabProject(remote)}/merge_requests/${n}/discussions`, o);
  return list.map((d) => {
    const notes = (d.notes || []).filter((nt) => !nt.system);
    const pos = notes[0]?.position;
    const side = pos && pos.new_line == null ? 'old' : 'new';
    const resolvable = notes.some((nt) => nt.resolvable);
    return {
      id: String(d.id),
      path: pos ? (side === 'old' ? pos.old_path : pos.new_path) : null,
      side,
      line: pos ? (side === 'old' ? pos.old_line : pos.new_line) : null,
      canReply: !d.individual_note || Boolean(pos),
      resolvable,
      resolved: resolvable && notes.filter((nt) => nt.resolvable).every((nt) => nt.resolved),
      notes: notes.map((nt) => noteOf(nt.author?.name || nt.author?.username, nt.body, nt.created_at)),
    };
  }).filter((t) => t.notes.length);
}

/** Nouveau thread : général, ou sur une ligne (`anchor` : { path, oldPath, oldLine, newLine }). */
async function createMergeRequestThread(remote, token, number, { body, anchor = null }, fetchFn) {
  const n = num(number);
  const o = opts(remote, token, fetchFn);
  if (isGitHub(remote)) {
    if (!anchor?.path) {
      await apiSend('POST', `${githubRepo(remote)}/issues/${n}/comments`, { body }, o);
      return true;
    }
    const pr = await apiGet(`${githubRepo(remote)}/pulls/${n}`, o);
    const onOld = anchor.newLine == null;
    await apiSend('POST', `${githubRepo(remote)}/pulls/${n}/comments`, {
      body, commit_id: pr.head.sha, path: onOld ? anchor.oldPath || anchor.path : anchor.path,
      line: onOld ? anchor.oldLine : anchor.newLine, side: onOld ? 'LEFT' : 'RIGHT',
    }, o);
    return true;
  }
  const payload = { body };
  if (anchor?.path) {
    const mr = await apiGet(`${gitlabProject(remote)}/merge_requests/${n}`, o);
    const refs = mr.diff_refs || {};
    if (!refs.head_sha) throw new HostingError('Impossible de commenter une ligne : versions du diff indisponibles.');
    payload.position = {
      position_type: 'text', base_sha: refs.base_sha, start_sha: refs.start_sha, head_sha: refs.head_sha,
      new_path: anchor.path, old_path: anchor.oldPath || anchor.path,
    };
    if (anchor.newLine != null) payload.position.new_line = anchor.newLine;
    if (anchor.oldLine != null) payload.position.old_line = anchor.oldLine;
  }
  await apiSend('POST', `${gitlabProject(remote)}/merge_requests/${n}/discussions`, payload, o);
  return true;
}

async function replyMergeRequestThread(remote, token, number, threadId, body, fetchFn) {
  const n = num(number);
  const o = opts(remote, token, fetchFn);
  if (isGitHub(remote)) {
    if (!/^\d+$/.test(threadId)) throw new HostingError('Ce commentaire ne prend pas de réponse : ajoutez un nouveau commentaire.');
    await apiSend('POST', `${githubRepo(remote)}/pulls/${n}/comments/${threadId}/replies`, { body }, o);
    return true;
  }
  await apiSend('POST', `${gitlabProject(remote)}/merge_requests/${n}/discussions/${encodeURIComponent(threadId)}/notes`, { body }, o);
  return true;
}

async function resolveMergeRequestThread(remote, token, number, threadId, resolved, fetchFn) {
  const n = num(number);
  if (isGitHub(remote)) throw new HostingError('La résolution des threads GitHub n’est pas prise en charge par GitPilot.');
  await apiSend('PUT', `${gitlabProject(remote)}/merge_requests/${n}/discussions/${encodeURIComponent(threadId)}?resolved=${resolved ? 'true' : 'false'}`,
    undefined, opts(remote, token, fetchFn));
  return true;
}

module.exports = {
  listMergeRequests, getMergeRequest, updateMergeRequest, mergeMergeRequest, mergeRequestCommits, mergeRequestChanges,
  mergeRequestThreads, createMergeRequestThread, replyMergeRequestThread, resolveMergeRequestThread, DRAFT_PREFIX_RE,
};
