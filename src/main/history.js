'use strict';

const { GitError, runGit, listBranches } = require('./git');

const PAGE_SIZE = 50;
const MAX_LINES_PER_FILE = 3000;
const MAX_TOTAL_LINES = 30_000;
const FIELD = '\x1f';
const RECORD = '\x1e';
const SHA_RE = /^[0-9a-f]{7,40}$/i;

/** La référence doit être une branche connue du dépôt (aucune option ni expression Git). */
async function assertBranchRef(projectPath, ref) {
  const { branches } = await listBranches(projectPath);
  const branch = branches.find((b) => b.ref === ref);
  if (!branch) throw new GitError('Branche introuvable : elle a peut-être été supprimée. Actualisez la liste.');
  return branch;
}

function assertSha(sha) {
  if (!SHA_RE.test(String(sha || ''))) throw new GitError('Identifiant de commit invalide.');
  return String(sha);
}

/** Historique d'une branche, du plus récent au plus ancien, par pages de 50 commits. */
async function commitLog(projectPath, ref, { skip = 0 } = {}) {
  const branch = await assertBranchRef(projectPath, ref);
  const offset = Math.max(0, Math.floor(Number(skip) || 0));
  const format = ['%H', '%h', '%P', '%an', '%ae', '%at', '%s'].join('%x1f') + '%x1e';
  const out = await runGit(projectPath, [
    'log', `--format=${format}`, `--max-count=${PAGE_SIZE + 1}`, `--skip=${offset}`, ref, '--',
  ]);
  const commits = out.split(RECORD).map((r) => r.replace(/^\s+/, '')).filter(Boolean).map((r) => {
    const [sha, shortSha, parents, author, email, date, subject] = r.split(FIELD);
    return {
      sha, shortSha, parents: parents ? parents.split(' ') : [], author, email,
      date: Number(date) * 1000, subject: subject || '',
    };
  });
  return {
    branch: { ref: branch.ref, name: branch.name, type: branch.type },
    commits: commits.slice(0, PAGE_SIZE),
    hasMore: commits.length > PAGE_SIZE,
  };
}

function unquotePath(p) {
  if (p.startsWith('"') && p.endsWith('"')) {
    try { return JSON.parse(p); } catch { return p.slice(1, -1); }
  }
  return p;
}

/**
 * Découpe la sortie de `git show --patch` en fichiers et en blocs (« hunks »).
 * Lignes : [type, n° ancien, n° nouveau, texte] avec type + (ajout), - (suppression),
 * ' ' (contexte) ou \ (« No newline at end of file »).
 */
function parsePatch(text) {
  const files = [];
  let file = null;
  let hunk = null;
  let oldNo = 0;
  let newNo = 0;
  let total = 0;

  for (const line of text.split('\n')) {
    if (line.startsWith('diff --git ')) {
      const m = line.match(/^diff --git a\/(.*) b\/(.*)$/);
      file = {
        oldPath: m ? unquotePath(m[1]) : null,
        newPath: m ? unquotePath(m[2]) : null,
        status: 'modified', binary: false, additions: 0, deletions: 0,
        hunks: [], truncated: false, lines: 0,
      };
      files.push(file);
      hunk = null;
      continue;
    }
    if (!file) continue;

    const hm = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/);
    if (hm) {
      oldNo = Number(hm[1]);
      newNo = Number(hm[2]);
      hunk = { header: line, lines: [] };
      if (!file.truncated) file.hunks.push(hunk);
      continue;
    }

    if (!hunk) {
      // En-têtes du fichier (avant le premier bloc).
      if (line.startsWith('new file mode')) file.status = 'added';
      else if (line.startsWith('deleted file mode')) file.status = 'deleted';
      else if (line.startsWith('rename from ')) { file.status = 'renamed'; file.oldPath = unquotePath(line.slice(12)); }
      else if (line.startsWith('rename to ')) file.newPath = unquotePath(line.slice(10));
      else if (line.startsWith('copy from ')) { file.status = 'copied'; file.oldPath = unquotePath(line.slice(10)); }
      else if (line.startsWith('copy to ')) file.newPath = unquotePath(line.slice(8));
      else if (line.startsWith('old mode ') && file.status === 'modified') file.status = 'mode';
      else if (line.startsWith('Binary files ') || line === 'GIT binary patch') file.binary = true;
      continue;
    }

    const type = line[0];
    let entry = null;
    if (type === '+') { file.additions += 1; entry = ['+', null, newNo, line.slice(1)]; newNo += 1; }
    else if (type === '-') { file.deletions += 1; entry = ['-', oldNo, null, line.slice(1)]; oldNo += 1; }
    else if (type === ' ') { entry = [' ', oldNo, newNo, line.slice(1)]; oldNo += 1; newNo += 1; }
    else if (type === '\\') entry = ['\\', null, null, line.slice(1).trim()];
    if (!entry) continue;

    if (file.lines >= MAX_LINES_PER_FILE || total >= MAX_TOTAL_LINES) {
      file.truncated = true;
      continue;
    }
    hunk.lines.push(entry);
    file.lines += 1;
    total += 1;
  }
  for (const f of files) {
    if (f.status === 'mode' && (f.additions || f.deletions)) f.status = 'modified';
    if (f.truncated) f.hunks = f.hunks.filter((hk) => hk.lines.length);
  }
  return { files, truncated: files.some((f) => f.truncated) };
}

/** Détail d'un commit : métadonnées complètes et diff par rapport au premier parent. */
async function commitDetail(projectPath, shaInput) {
  const sha = assertSha(shaInput);
  const format = ['%H', '%h', '%P', '%an', '%ae', '%at', '%cn', '%ce', '%ct', '%D', '%B'].join('%x1f');
  let meta;
  try {
    meta = await runGit(projectPath, ['show', '-s', `--format=${format}`, `${sha}^{commit}`, '--']);
  } catch (err) {
    if (/unknown revision|bad revision|bad object|ambiguous argument|not a valid object/i.test(err.details || '')) {
      throw new GitError(`Commit ${sha} introuvable dans ce dépôt.`);
    }
    throw err;
  }
  const [full, shortSha, parents, author, email, date, committer, committerEmail, committerDate, refs, ...body] = meta.split(FIELD);
  const message = body.join(FIELD).replace(/\s+$/, '');
  const patch = await runGit(projectPath, [
    'show', '--format=', '--patch', '--no-color', '--no-ext-diff', '--no-textconv', '-M',
    '--diff-merges=first-parent', `${full}^{commit}`, '--',
  ], { timeout: 60_000 });
  const diff = parsePatch(patch);
  return {
    sha: full,
    shortSha,
    parents: parents ? parents.split(' ').filter(Boolean) : [],
    author, email, date: Number(date) * 1000,
    committer, committerEmail, committerDate: Number(committerDate) * 1000,
    refs: refs ? refs.split(', ').filter(Boolean) : [],
    subject: message.split('\n')[0] || '',
    body: message.split('\n').slice(1).join('\n').replace(/^\n+/, ''),
    files: diff.files,
    truncated: diff.truncated,
    stats: {
      files: diff.files.length,
      additions: diff.files.reduce((n, f) => n + f.additions, 0),
      deletions: diff.files.reduce((n, f) => n + f.deletions, 0),
    },
  };
}

module.exports = { commitLog, commitDetail, parsePatch };
