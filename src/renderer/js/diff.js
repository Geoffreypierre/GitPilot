'use strict';

/**
 * Affichage commun aux pages commit et merge request : diff par fichier (coloration
 * syntaxique, numéros de ligne) et threads (discussion générale ou sur une ligne,
 * réponses, résolution), sur le modèle de GitLab.
 *
 * Contexte attendu par `files()` :
 *   canComment        commentaires de ligne autorisés
 *   keyFor(anchor)    clé de rattachement d'une ligne du diff
 *   lineThreads       Map clé → threads affichés sous la ligne
 *   createLineThread(anchor, text) → Promise
 *   actions           { canWrite, reply(thread, text), resolve?(thread, resolved) }
 */
const DiffView = (() => {
  const AUTO_COLLAPSE_LINES = 800; // les très gros fichiers sont repliés par défaut
  const STATUS = {
    added: ['nouveau', 'badge-success'],
    deleted: ['supprimé', 'badge-danger'],
    renamed: ['renommé', 'badge-info'],
    copied: ['copié', 'badge-info'],
    mode: ['droits modifiés', 'badge-muted'],
  };

  /* ---------- Utilitaires partagés ---------- */

  function avatar(name, email) {
    return h('span', { class: 'commit-avatar', dataset: email ? { email } : null, style: { background: colorFor(name || '?') } }, initials(name || '?'));
  }

  /** Remplace les initiales par la photo de profil GitHub / GitLab quand elle est disponible. */
  async function loadAvatars(container, projectId, ref) {
    const nodes = [...container.querySelectorAll('.commit-avatar[data-email]:not(.has-photo)')];
    const emails = [...new Set(nodes.map((n) => n.dataset.email))];
    if (!emails.length) return;
    let photos = {};
    try { photos = await window.gitpilot.git.avatars(projectId, { ref: ref || null, emails }); } catch { return; }
    for (const node of nodes) {
      const uri = photos[node.dataset.email];
      if (!uri || !node.isConnected) continue;
      clear(node);
      node.classList.add('has-photo');
      node.append(h('img', { src: uri, alt: '' }));
    }
  }

  async function copy(text, message) {
    try {
      await navigator.clipboard.writeText(text);
      UI.toast(message, 'success');
    } catch {
      UI.toast('Copie impossible.', 'danger');
    }
  }

  function shaPill(sha, shortSha) {
    return h('span', { class: 'sha-pill' },
      h('span', { class: 'mono' }, shortSha),
      h('button', {
        class: 'sha-copy', type: 'button', title: "Copier l'identifiant complet", 'aria-label': "Copier l'identifiant complet", html: icon('copy'),
        onclick: (e) => { e.preventDefault(); e.stopPropagation(); copy(sha, 'Identifiant du commit copié.'); },
      }));
  }

  function backLink(href, label) {
    return h('a', { class: 'back-link', href }, iconEl('chevronLeft'), label);
  }

  /* ---------- Coloration syntaxique (highlight.js, chargé par index.html) ---------- */
  const LANG_BY_EXT = {
    js: 'javascript', mjs: 'javascript', cjs: 'javascript', jsx: 'javascript',
    ts: 'typescript', tsx: 'typescript', mts: 'typescript', cts: 'typescript',
    json: 'json', css: 'css', scss: 'scss', less: 'less',
    html: 'xml', htm: 'xml', xml: 'xml', svg: 'xml', vue: 'xml',
    md: 'markdown', markdown: 'markdown', py: 'python', rb: 'ruby', php: 'php',
    java: 'java', kt: 'kotlin', kts: 'kotlin', swift: 'swift', go: 'go', rs: 'rust',
    c: 'c', h: 'c', cpp: 'cpp', cc: 'cpp', cxx: 'cpp', hpp: 'cpp', cs: 'csharp',
    sh: 'bash', bash: 'bash', zsh: 'bash', ps1: 'powershell', psm1: 'powershell', bat: 'dos', cmd: 'dos',
    yml: 'yaml', yaml: 'yaml', toml: 'ini', ini: 'ini', cfg: 'ini', sql: 'sql',
  };

  function languageFor(filePath) {
    if (typeof hljs === 'undefined' || !filePath) return null;
    const name = filePath.split('/').pop().toLowerCase();
    const ext = name.includes('.') ? name.split('.').pop() : '';
    const lang = LANG_BY_EXT[ext];
    return lang && hljs.getLanguage(lang) ? lang : null;
  }

  /** Cellule de code : HTML produit par highlight.js (qui échappe le texte source), sinon texte brut. */
  function codeCell(text, lang) {
    const td = h('td', { class: 'code' });
    if (lang && text.length <= 2000) {
      try {
        td.innerHTML = hljs.highlight(text, { language: lang, ignoreIllegals: true }).value;
        return td;
      } catch { /* texte brut ci-dessous */ }
    }
    td.textContent = text;
    return td;
  }

  /**
   * Parcourt les lignes d'un fichier du diff avec leur ancrage : numéros de ligne
   * et position dans le diff (GitHub, commits : 1 = ligne sous le premier « @@ »).
   */
  function forEachDiffLine(f, fn) {
    const path = f.newPath || f.oldPath;
    let position = 0;
    f.hunks.forEach((hunk, hi) => {
      if (hi > 0) position += 1; // les en-têtes « @@ » suivants comptent comme des lignes
      fn({ hunk });
      for (const [type, oldNo, newNo, text] of hunk.lines) {
        position += 1;
        const anchor = type === '\\' ? null : {
          path, oldPath: f.oldPath || path, position,
          oldLine: type === '+' ? null : oldNo,
          newLine: type === '-' ? null : newNo,
        };
        fn({ type, oldNo, newNo, text, anchor });
      }
    });
  }

  /** Clé « fichier | côté | ligne », commune aux threads GitLab et aux revues GitHub. */
  const lineKey = (anchor) => (anchor.newLine != null ? `${anchor.path}|new|${anchor.newLine}` : `${anchor.path}|old|${anchor.oldLine}`);
  const threadLineKey = (t) => (t.path && t.line != null ? `${t.path}|${t.side}|${t.line}` : null);

  /**
   * Répartit les threads : ceux qui correspondent à une ligne du diff sont affichés
   * sous la ligne, les autres (généraux, lignes absentes du diff) dans la discussion.
   */
  function splitThreads(threads, files, keyFor, threadKeyFor) {
    const keys = new Set();
    for (const f of files) forEachDiffLine(f, ({ anchor }) => { if (anchor) keys.add(keyFor(anchor)); });
    const lineThreads = new Map();
    const general = [];
    for (const t of threads) {
      const key = threadKeyFor(t);
      if (key && keys.has(key)) {
        if (!lineThreads.has(key)) lineThreads.set(key, []);
        lineThreads.get(key).push(t);
      } else {
        general.push({ thread: t, label: t.path ? `${t.path}${t.line ? `:${t.line}` : ''}${t.outdated ? ' (obsolète)' : ''}` : null });
      }
    }
    return { lineThreads, general };
  }

  /* ---------- Threads ---------- */

  function noteEl(note) {
    return h('div', { class: 'thread-note' },
      h('span', { class: 'commit-avatar sm', style: { background: colorFor(note.author || '?') } }, initials(note.author || '?')),
      h('div', { class: 'thread-note-main' },
        h('div', { class: 'thread-note-head' },
          h('strong', null, note.author),
          note.createdAt ? h('span', { class: 'muted', title: formatDate(note.createdAt) }, formatRelative(note.createdAt)) : null),
        h('div', { class: 'thread-note-body' }, Markdown.render(note.body))));
  }

  function commentForm({ placeholder, submitLabel, onSubmit, onCancel }) {
    const input = h('textarea', { class: 'textarea thread-input', rows: '3', placeholder });
    const errorBox = h('div');
    const submitBtn = h('button', { class: 'btn btn-sm btn-accent', type: 'submit' }, submitLabel);
    const form = h('form', { class: 'thread-form', novalidate: true },
      errorBox,
      input,
      h('div', { class: 'thread-form-actions' },
        h('span', { class: 'muted' }, 'Ctrl+Entrée pour envoyer'),
        onCancel ? h('button', { class: 'btn btn-sm', type: 'button', onclick: onCancel }, 'Annuler') : null,
        submitBtn));
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); form.requestSubmit(); }
    });
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      clear(errorBox);
      const text = input.value.trim();
      if (!text) { input.focus(); return; }
      UI.setLoading(submitBtn, true, 'Envoi…');
      try {
        await onSubmit(text);
        input.value = '';
      } catch (err) {
        errorBox.append(UI.alert('danger', err.message));
      } finally {
        if (submitBtn.isConnected) UI.setLoading(submitBtn, false);
      }
    });
    form.focusInput = () => input.focus();
    return form;
  }

  const localThread = (text) => ({ id: null, canReply: false, resolvable: false, resolved: false, notes: [{ author: 'Vous', body: text, createdAt: Date.now() }] });

  /** Bloc d'un thread : notes, réponse, résolution (les threads résolus sont repliés, comme sur GitLab). */
  function threadBox(thread, actions = {}, label = null) {
    const box = h('div', { class: `thread ${thread.resolved ? 'is-resolved' : ''}` });

    function render() {
      clear(box);
      box.classList.toggle('is-resolved', Boolean(thread.resolved));
      const notes = h('div', { class: 'thread-notes' }, thread.notes.map(noteEl));
      const footer = h('div', { class: 'thread-footer' });

      if (thread.resolved) {
        const n = thread.notes.length;
        notes.hidden = true;
        const toggle = h('button', {
          class: 'thread-resolved-head', type: 'button',
          onclick: () => { notes.hidden = !notes.hidden; footer.hidden = notes.hidden; toggle.classList.toggle('open', !notes.hidden); },
        }, iconEl('checkCircle'), `Thread résolu · ${n} commentaire${n > 1 ? 's' : ''}`, label ? h('span', { class: 'mono muted' }, ` · ${label}`) : null);
        box.append(toggle);
        footer.hidden = true;
      } else if (label) {
        box.append(h('div', { class: 'thread-label mono' }, label));
      }
      box.append(notes, footer);

      if (thread.id && thread.canReply && actions.canWrite) {
        const replyBtn = h('button', {
          class: 'btn btn-sm', type: 'button', html: `${icon('comment')}<span>Répondre</span>`,
          onclick: () => {
            replyBtn.hidden = true;
            const form = commentForm({
              placeholder: 'Répondre… (Markdown)',
              submitLabel: 'Répondre',
              onCancel: () => { form.remove(); replyBtn.hidden = false; },
              onSubmit: async (text) => {
                await actions.reply(thread, text);
                if (actions.refresh) { await actions.refresh(); return; }
                thread.notes.push({ author: 'Vous', body: text, createdAt: Date.now() });
                render();
              },
            });
            box.append(form);
            form.focusInput();
          },
        });
        footer.append(replyBtn);
      }
      if (thread.id && thread.resolvable && actions.canWrite && actions.resolve) {
        const resolveBtn = h('button', {
          class: 'btn btn-sm', type: 'button',
          html: thread.resolved ? `${icon('refresh')}<span>Rouvrir le thread</span>` : `${icon('checkCircle')}<span>Résoudre le thread</span>`,
          onclick: async () => {
            UI.setLoading(resolveBtn, true);
            try {
              await actions.resolve(thread, !thread.resolved);
              if (actions.refresh) { await actions.refresh(); return; }
              thread.resolved = !thread.resolved;
              render();
            } catch (err) {
              UI.setLoading(resolveBtn, false);
              UI.toast(err.message, 'danger');
            }
          },
        });
        footer.append(resolveBtn);
      }
    }

    render();
    return box;
  }

  const threadRow = (threads, actions) => h('tr', { class: 'thread-row' },
    h('td', { colspan: '3' }, threads.map((t) => threadBox(t, actions))));

  function openLineForm(tr, anchor, ctx) {
    let after = tr;
    while (after.nextElementSibling?.classList.contains('thread-row')) after = after.nextElementSibling;
    if (after.classList.contains('thread-form-row')) { after.querySelector('textarea')?.focus(); return; }
    const cell = h('td', { colspan: '3' });
    const formRow = h('tr', { class: 'thread-row thread-form-row' }, cell);
    const form = commentForm({
      placeholder: 'Commenter cette ligne… (Markdown)',
      submitLabel: 'Commenter',
      onCancel: () => formRow.remove(),
      onSubmit: async (text) => {
        await ctx.createLineThread(anchor, text);
        if (ctx.actions?.refresh) { await ctx.actions.refresh(); return; }
        formRow.replaceWith(threadRow([localThread(text)], ctx.actions));
      },
    });
    cell.append(h('div', { class: 'thread' }, form));
    after.after(formRow);
    form.focusInput();
  }

  /* ---------- Diff ---------- */

  function diffTable(f, ctx) {
    const lang = languageFor(f.newPath || f.oldPath);
    const rows = [];
    forEachDiffLine(f, ({ hunk, type, oldNo, newNo, text, anchor }) => {
      if (hunk) {
        rows.push(h('tr', { class: 'diff-hunk' },
          h('td', { class: 'ln' }, '…'), h('td', { class: 'ln' }, '…'), h('td', { class: 'code' }, hunk.header)));
        return;
      }
      if (type === '\\') {
        rows.push(h('tr', { class: 'diff-line meta' }, h('td', { class: 'ln' }), h('td', { class: 'ln' }), h('td', { class: 'code' }, text)));
        return;
      }
      const cls = { '+': 'add', '-': 'del', ' ': 'ctx' }[type];
      const oldCell = h('td', { class: 'ln' }, oldNo ?? '');
      const tr = h('tr', { class: `diff-line ${cls}` }, oldCell, h('td', { class: 'ln' }, newNo ?? ''), codeCell(text, lang));
      if (ctx?.canComment) {
        oldCell.append(h('button', {
          class: 'line-comment-btn', type: 'button', title: 'Commenter cette ligne', 'aria-label': 'Commenter cette ligne', html: icon('comment'),
          onclick: (e) => { e.stopPropagation(); openLineForm(tr, anchor, ctx); },
        }));
      }
      rows.push(tr);
      const threads = ctx?.lineThreads?.get(ctx.keyFor(anchor));
      if (threads?.length) rows.push(threadRow(threads, ctx.actions));
    });
    return h('table', { class: 'diff-table' }, h('tbody', null, rows));
  }

  function fileHeaderPath(f) {
    if ((f.status === 'renamed' || f.status === 'copied') && f.oldPath !== f.newPath) {
      return [h('span', { class: 'muted' }, f.oldPath), ' → ', f.newPath];
    }
    return f.status === 'deleted' ? f.oldPath : f.newPath;
  }

  function fileBlock(f, index, ctx) {
    const body = h('div', { class: 'diff-body' });
    const chevron = h('span', { class: 'diff-chevron', html: icon('chevronDown') });
    const status = STATUS[f.status] || null;
    let collapsed = f.lines > AUTO_COLLAPSE_LINES;
    let rendered = false;

    function render() {
      if (rendered) return;
      rendered = true;
      if (f.unavailable) body.append(h('div', { class: 'diff-note' }, 'Diff non fourni par le serveur (fichier binaire ou trop volumineux).'));
      else if (f.binary) body.append(h('div', { class: 'diff-note' }, 'Fichier binaire : contenu non affiché.'));
      else if (!f.hunks.length) {
        body.append(h('div', { class: 'diff-note' }, f.status === 'mode' ? 'Seuls les droits du fichier ont changé.' : 'Aucune modification de contenu.'));
      } else body.append(diffTable(f, ctx));
      if (f.truncated) body.append(h('div', { class: 'diff-note' }, 'Diff tronqué : fichier trop volumineux pour être affiché en entier.'));
    }

    function sync() {
      body.hidden = collapsed;
      chevron.classList.toggle('collapsed', collapsed);
      if (!collapsed) render();
    }

    let threadCount = 0;
    if (ctx?.lineThreads) forEachDiffLine(f, ({ anchor }) => { if (anchor) threadCount += ctx.lineThreads.get(ctx.keyFor(anchor))?.length || 0; });

    const head = h('button', {
      class: 'diff-file-head', type: 'button', 'aria-expanded': String(!collapsed),
      onclick: () => { collapsed = !collapsed; head.setAttribute('aria-expanded', String(!collapsed)); sync(); },
    },
      chevron,
      h('span', { class: 'diff-path mono ellipsis' }, fileHeaderPath(f)),
      status ? h('span', { class: `badge ${status[1]}` }, status[0]) : null,
      threadCount ? h('span', { class: 'badge badge-muted', title: 'Threads sur ce fichier' }, iconEl('comment'), String(threadCount)) : null,
      h('span', { class: 'diff-counts' },
        h('span', { class: 'add' }, `+${f.additions}`),
        h('span', { class: 'del' }, `−${f.deletions}`)),
    );
    const el = h('div', { class: 'diff-file', id: `file-${index}` }, head, body);
    el.setCollapsed = (value) => { collapsed = value; head.setAttribute('aria-expanded', String(!collapsed)); sync(); };
    sync();
    return el;
  }

  /**
   * Résumé + fichiers du diff. Renvoie les éléments à insérer dans la page.
   * `note` : précision affichée dans le résumé (ex. « différences avec le premier parent »).
   */
  function files(diff, ctx, { note = null, emptyText = 'Aucun fichier modifié.' } = {}) {
    const blocks = diff.files.map((f, i) => fileBlock(f, i, ctx));
    const setAll = (value) => blocks.forEach((el) => el.setCollapsed(value));
    const { stats } = diff;
    return [
      h('div', { class: 'diff-summary' },
        h('span', null, `${stats.files} fichier${stats.files > 1 ? 's' : ''} modifié${stats.files > 1 ? 's' : ''}`),
        h('span', { class: 'add' }, `+${stats.additions}`),
        h('span', { class: 'del' }, `−${stats.deletions}`),
        note ? h('span', { class: 'muted' }, note) : null,
        h('div', { class: 'diff-summary-actions' },
          h('button', { class: 'btn btn-sm btn-tertiary', type: 'button', onclick: () => setAll(true) }, 'Tout replier'),
          h('button', { class: 'btn btn-sm btn-tertiary', type: 'button', onclick: () => setAll(false) }, 'Tout déplier'),
        ),
      ),
      ...(diff.truncated ? [UI.alert('warning', 'Diff très volumineux : certains fichiers sont tronqués.')] : []),
      blocks.length ? h('div', { class: 'diff-files' }, blocks) : h('div', { class: 'empty-inline' }, emptyText),
    ];
  }

  /**
   * Section « Discussion » : threads généraux et formulaire de nouveau thread.
   * `state` : { status: ok | disconnected | error | none, host, error }.
   */
  function discussion({ state, general = [], lineCount = 0, actions = {}, onCreate, onConnected }) {
    if (!state || state.status === 'none') return [];
    const head = h('h2', { class: 'discussion-title' }, iconEl('comment'), 'Discussion');
    const identity = state.status === 'ok' && state.host ? Accounts.identityBar(state.host, { onChange: onConnected }) : null;
    if (state.status === 'disconnected') {
      return [head, h('div', { class: 'discussion-empty' },
        `Connectez votre compte ${state.host} pour voir et créer des threads.`,
        h('button', {
          class: 'btn btn-sm', type: 'button', style: { marginLeft: '12px' },
          onclick: async () => { if (await Accounts.openConnectModal(state.host)) onConnected?.(); },
        }, `Connecter ${state.host}`))];
    }
    if (state.status === 'error') return [head, UI.alert('warning', state.error, 'Threads indisponibles')];

    const list = h('div', { class: 'discussion-list' }, general.map(({ thread, label }) => threadBox(thread, actions, label)));
    const empty = h('div', { class: 'discussion-empty', hidden: general.length > 0 }, 'Aucun thread général pour l’instant.');
    const form = commentForm({
      placeholder: 'Démarrer un thread… (Markdown)',
      submitLabel: 'Commenter',
      onSubmit: async (text) => {
        await onCreate(text);
        if (actions.refresh) { await actions.refresh(); return; }
        empty.hidden = true;
        list.append(threadBox(localThread(text), actions));
      },
    });
    return [
      head,
      identity,
      lineCount > 0 ? h('div', { class: 'muted', style: { fontSize: '13px', marginBottom: '10px' } },
        `${lineCount} thread${lineCount > 1 ? 's' : ''} sur des lignes du diff (affichés sous les lignes concernées).`) : null,
      empty,
      list,
      h('div', { class: 'thread discussion-new' }, form),
    ].filter(Boolean);
  }

  return {
    avatar, loadAvatars, copy, shaPill, backLink,
    forEachDiffLine, lineKey, threadLineKey, splitThreads, threadBox, commentForm, files, discussion,
  };
})();
