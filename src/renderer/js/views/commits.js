'use strict';

/**
 * Historique d'une branche et détail d'un commit (inspirés des pages GitLab) :
 * mêmes informations que `git log` / `git show` (diff par rapport au premier parent).
 * Le diff et les threads sont rendus par DiffView (diff.js).
 */
const CommitsView = (() => {
  const DAY = new Intl.DateTimeFormat('fr-FR', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
  const { avatar, loadAvatars, copy, shaPill, backLink } = DiffView;

  const branchLabel = (ref) => String(ref || '').replace(/^refs\/(heads|remotes)\//, '');

  function notFound(root) {
    root.append(h('div', { class: 'page' }, h('div', { class: 'empty-state' },
      h('div', { class: 'empty-icon', html: icon('warning') }),
      h('h3', null, 'Projet introuvable'),
      h('p', null, "Ce projet n'existe pas ou a été retiré du dashboard."),
      h('a', { class: 'btn', href: '#/' }, 'Retour au dashboard'),
    )));
    return () => {};
  }

  /** Ligne de commit (liste d'une branche, onglet Commits d'une merge request). */
  function commitRow(projectId, c, ref) {
    return h('a', { class: 'list-item commit-row', href: `#/project/${projectId}/commit/${c.sha}${ref ? `?ref=${encodeURIComponent(ref)}` : ''}` },
      avatar(c.author, c.email),
      h('div', { class: 'commit-main' },
        h('div', { class: 'commit-subject ellipsis' }, c.subject || '(sans message)'),
        h('div', { class: 'commit-meta' },
          h('strong', null, c.author), ' a validé ', h('span', { title: formatDate(c.date) }, formatRelative(c.date)),
          c.parents?.length > 1 ? h('span', { class: 'badge badge-muted' }, 'merge') : null),
      ),
      shaPill(c.sha, c.shortSha),
    );
  }

  /** Commits groupés par jour, ajoutés à `container` (appels successifs possibles). */
  function appendByDay(container, commits, rowFor, state = { lastDay: null, group: null }) {
    for (const c of commits) {
      const day = DAY.format(new Date(c.date));
      if (day !== state.lastDay) {
        state.lastDay = day;
        state.group = h('div', { class: 'list' });
        container.append(h('h3', { class: 'commit-day' }, day.charAt(0).toUpperCase() + day.slice(1)), state.group);
      }
      state.group.append(rowFor(c));
    }
    return state;
  }

  /* =====================================================
     Historique d'une branche
     ===================================================== */
  function mountList(root, projectId, params = {}) {
    const project = State.getProject(projectId);
    if (!project) return notFound(root);
    const ref = params.ref || '';
    let destroyed = false;
    let skip = 0;
    let dayState;

    const listEl = h('div', { class: 'commit-days' });
    const footer = h('div', { class: 'list-footer' });
    root.append(h('div', { class: 'page' },
      backLink(`#/project/${projectId}?tab=branches`, `Branches de ${project.name}`),
      h('div', { class: 'page-header' },
        h('div', { style: { minWidth: 0 } },
          h('h1', { class: 'page-title' }, 'Commits'),
          h('div', { class: 'current-branch' }, iconEl('branch'), h('span', null, 'Branche'), h('span', { class: 'name' }, branchLabel(ref))),
        ),
      ),
      listEl,
      footer,
    ));

    async function load() {
      clear(footer);
      footer.append(h('span', { class: 'inline-spinner' }, h('span', { class: 'spinner' }), 'Chargement des commits…'));
      let data;
      try {
        data = await window.gitpilot.git.log(projectId, { ref, skip });
      } catch (err) {
        if (destroyed) return;
        clear(footer);
        listEl.append(UI.alert('danger', err.message, "Impossible de lire l'historique"));
        return;
      }
      if (destroyed) return;
      dayState = appendByDay(listEl, data.commits, (c) => commitRow(projectId, c, ref), dayState);
      skip += data.commits.length;
      loadAvatars(listEl, projectId, ref);
      clear(footer);
      if (!skip) {
        listEl.append(h('div', { class: 'empty-inline' }, 'Aucun commit sur cette branche.'));
        return;
      }
      footer.append(h('span', null, `${skip} commit${skip > 1 ? 's' : ''} affiché${skip > 1 ? 's' : ''}${data.hasMore ? '' : ' (début de la branche atteint)'}`));
      if (data.hasMore) {
        footer.append(h('button', { class: 'btn btn-sm', type: 'button', onclick: load, html: `${icon('chevronDown')}<span>Charger plus de commits</span>` }));
      }
    }

    load();
    return () => { destroyed = true; };
  }

  /* =====================================================
     Détail d'un commit
     ===================================================== */
  function mountCommit(root, projectId, sha, params = {}) {
    const project = State.getProject(projectId);
    if (!project) return notFound(root);
    let destroyed = false;
    const ref = params.ref || '';
    const back = ref
      ? backLink(`#/project/${projectId}/commits?ref=${encodeURIComponent(ref)}`, 'Retour')
      : backLink(params.mr ? `#/project/${projectId}/mr/${params.mr}?tab=commits` : `#/project/${projectId}?tab=branches`, 'Retour');
    const body = h('div', null, h('div', { class: 'loading-block' }, h('span', { class: 'spinner spinner-lg' }), 'Chargement du commit…'));
    root.append(h('div', { class: 'page' }, back, body));

    (async () => {
      const [commitRes, threadsRes] = await Promise.allSettled([
        window.gitpilot.git.commit(projectId, sha),
        window.gitpilot.hosting.threads(projectId, sha),
      ]);
      if (destroyed) return;
      clear(body);
      if (commitRes.status === 'rejected') {
        body.append(UI.alert('danger', commitRes.reason.message, 'Impossible de lire ce commit'));
        return;
      }
      const c = commitRes.value;
      let threadState = threadsRes.status === 'fulfilled' ? threadsRes.value : { status: 'error', error: threadsRes.reason.message };

      /** Relit les threads sur le serveur : l'affichage reflète ce qui est réellement enregistré. */
      async function refresh() {
        try { threadState = await window.gitpilot.hosting.threads(projectId, sha); } catch (err) { threadState = { status: 'error', error: err.message }; }
        if (!destroyed) render();
      }

      function render() {
      clear(body);

      // Commentaires de commit GitHub : rattachés par position dans le diff ; GitLab : par numéro de ligne.
      const github = threadState.provider === 'github';
      const keyFor = github ? (a) => `${a.path}#${a.position}` : DiffView.lineKey;
      const threadKeyFor = github ? (t) => (t.path && t.position ? `${t.path}#${t.position}` : null) : DiffView.threadLineKey;
      const canWrite = threadState.status === 'ok';
      const { lineThreads, general } = canWrite
        ? DiffView.splitThreads(threadState.threads, c.files, keyFor, threadKeyFor)
        : { lineThreads: new Map(), general: [] };
      const actions = {
        canWrite,
        reply: (thread, text) => window.gitpilot.hosting.replyThread(projectId, c.sha, thread.id, text),
        refresh,
      };
      const ctx = {
        canComment: canWrite && (github || Boolean(c.parents[0])),
        keyFor,
        lineThreads,
        actions,
        createLineThread: (anchor, text) => window.gitpilot.hosting.createThread(projectId, c.sha, { body: text, anchor, parent: c.parents[0] || null }),
      };

      const commitLink = (parentSha) => h('a', {
        class: 'mono', href: `#/project/${projectId}/commit/${parentSha}${ref ? `?ref=${encodeURIComponent(ref)}` : ''}`,
      }, parentSha.slice(0, 8));
      const sameCommitter = c.committer === c.author && c.committerEmail === c.email && c.committerDate === c.date;

      body.append(
        h('div', { class: 'page-header' },
          h('div', { style: { minWidth: 0 } },
            h('h1', { class: 'page-title commit-sha-title mono' }, c.shortSha),
          ),
          h('div', { class: 'page-actions' },
            h('button', { class: 'btn btn-sm', type: 'button', html: `${icon('copy')}<span>Copier le SHA</span>`, onclick: () => copy(c.sha, 'Identifiant du commit copié.') })),
        ),
        h('div', { class: 'commit-card' },
          h('div', { class: 'commit-author' },
            avatar(c.author, c.email),
            h('div', null,
              h('div', null, h('strong', null, c.author)),
              h('div', { class: 'muted' }, formatDate(c.date)),
              sameCommitter ? null : h('div', { class: 'muted' }, `Validé par ${c.committer} le ${formatDate(c.committerDate)}`),
            ),
          ),
          h('dl', { class: 'kv commit-kv' },
            h('dt', null, 'SHA'), h('dd', { class: 'mono' }, c.sha),
            h('dt', null, c.parents.length > 1 ? 'Parents' : 'Parent'),
            h('dd', null, c.parents.length ? c.parents.flatMap((p, i) => (i ? [' ', commitLink(p)] : [commitLink(p)])) : h('span', { class: 'muted' }, 'aucun (premier commit)')),
            c.refs.length ? [h('dt', null, 'Références'), h('dd', { class: 'commit-refs' }, c.refs.map((r) => h('span', { class: 'badge badge-muted' }, r)))] : null,
          ),
          h('h2', { class: 'commit-title' }, c.subject || '(sans message)'),
          c.body ? h('pre', { class: 'commit-body' }, c.body) : null,
        ),
        ...DiffView.files(c, ctx, {
          note: c.parents.length > 1 ? '(différences avec le premier parent)' : null,
          emptyText: 'Ce commit ne modifie aucun fichier.',
        }),
        h('section', { class: 'discussion' }, DiffView.discussion({
          state: threadState,
          general,
          lineCount: canWrite ? threadState.threads.length - general.length : 0,
          actions,
          onCreate: (text) => window.gitpilot.hosting.createThread(projectId, c.sha, { body: text, parent: c.parents[0] || null }),
          onConnected: () => App.navigate(location.hash.slice(1)),
        })),
      );
      loadAvatars(body, projectId, ref);
      }

      render();
    })();

    return () => { destroyed = true; };
  }

  return { mountList, mountCommit, commitRow, appendByDay, notFound };
})();
