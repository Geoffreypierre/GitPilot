'use strict';

const ProjectView = (() => {
  const TOP_BRANCHES = 5;
  const PAGE_SIZE = 10;
  const AUTO_FETCH_MAX_AGE = 2 * 60 * 1000;
  const branchCache = new Map(); // projectId -> { current, branches, fetch }

  function mount(root, projectId, params = {}) {
    const project = State.getProject(projectId);
    if (!project) {
      root.append(h('div', { class: 'page' }, h('div', { class: 'empty-state' },
        h('div', { class: 'empty-icon', html: icon('warning') }),
        h('h3', null, 'Projet introuvable'),
        h('p', null, "Ce projet n'existe pas ou a été retiré du dashboard."),
        h('a', { class: 'btn', href: '#/' }, 'Retour au dashboard'),
      )));
      return () => {};
    }

    const cleanups = [];
    let destroyed = false;
    cleanups.push(() => { destroyed = true; });

    /* =====================================================
       En-tête + onglets
       ===================================================== */
    let activeTab = params.tab || prefs.get(`tab.${projectId}`, 'branches');

    const fetchBtn = h('button', { class: 'btn', title: 'git fetch --all --prune puis rechargement des branches', html: `${icon('refresh')}<span>Actualiser (fetch)</span>`, onclick: () => loadBranches({ fetch: true, manual: true }) });
    const moreBtn = h('button', {
      class: 'btn btn-icon', title: 'Plus d’options', 'aria-label': 'Plus d’options', html: icon('ellipsis'),
      onclick: () => UI.dropdown(moreBtn, [
        { label: 'Ouvrir le dossier', icon: 'folder', onClick: () => HomeView.openFolder(project) },
        'sep',
        { label: 'Retirer du dashboard', icon: 'trash', danger: true, onClick: () => HomeView.removeProject(project) },
      ]),
    });

    const branchCount = h('span', { class: 'count-badge' }, '…');
    const actionCount = h('span', { class: 'count-badge' }, String(project.actions.length));
    const tabBranches = h('button', { class: 'tab', role: 'tab', onclick: () => setTab('branches') }, 'Branches', branchCount);
    const tabActions = h('button', { class: 'tab', role: 'tab', onclick: () => setTab('actions') }, 'Actions', actionCount);
    const panelBranches = h('section', { role: 'tabpanel', 'aria-label': 'Informations et branches Git' });
    const panelActions = h('section', { role: 'tabpanel', 'aria-label': 'Actions personnalisées' });

    root.append(h('div', { class: 'page' },
      h('div', { class: 'page-header' },
        h('div', { style: { minWidth: 0 } },
          h('h1', { class: 'page-title ellipsis' }, `Projet : ${project.name}`),
          h('p', { class: 'page-subtitle' }, 'Gestion du dépôt Git'),
          h('div', { class: 'page-path mono', title: project.path }, iconEl('folder'), project.path),
        ),
        h('div', { class: 'page-actions' }, fetchBtn, moreBtn),
      ),
      h('div', { class: 'tabs', role: 'tablist' }, tabBranches, tabActions),
      panelBranches,
      panelActions,
    ));

    function setTab(tab) {
      activeTab = tab === 'actions' ? 'actions' : 'branches';
      prefs.set(`tab.${projectId}`, activeTab);
      tabBranches.classList.toggle('active', activeTab === 'branches');
      tabActions.classList.toggle('active', activeTab === 'actions');
      tabBranches.setAttribute('aria-selected', String(activeTab === 'branches'));
      tabActions.setAttribute('aria-selected', String(activeTab === 'actions'));
      panelBranches.hidden = activeTab !== 'branches';
      panelActions.hidden = activeTab !== 'actions';
    }

    /* =====================================================
       Section Git : branches
       ===================================================== */
    const br = {
      data: branchCache.get(projectId) || null,
      error: null,
      loading: false,
      fetching: false,
      query: '',
      scope: 'all',
      expanded: false,
      page: 0,
    };

    const currentSlot = h('div');
    const fetchInfo = h('div', { class: 'inline-spinner', style: { marginLeft: 'auto' } });
    const alertSlot = h('div');
    const searchInput = h('input', {
      class: 'input', type: 'text', placeholder: 'Rechercher parmi toutes les branches…', spellcheck: 'false',
      oninput: () => { br.query = searchInput.value; br.page = 0; clearSearch.hidden = !br.query; renderBranchList(); },
      onkeydown: (e) => { if (e.key === 'Escape' && br.query) { e.stopPropagation(); resetSearch(); } },
    });
    const clearSearch = h('button', { class: 'icon-btn clear-btn', title: 'Effacer', hidden: true, html: icon('close'), onclick: () => resetSearch() });
    const scopeButtons = [['all', 'Toutes'], ['local', 'Locales'], ['remote', 'Distantes']].map(([value, label]) => h('button', {
      type: 'button', dataset: { scope: value },
      onclick: () => { br.scope = value; br.page = 0; renderBranchList(); },
    }, label));
    const listSlot = h('div');
    const footerSlot = h('div', { class: 'list-footer' });

    panelBranches.append(
      h('div', { class: 'toolbar' }, currentSlot, fetchInfo),
      alertSlot,
      h('div', { class: 'toolbar' },
        h('div', { class: 'search-box' }, iconEl('search'), searchInput, clearSearch),
        h('div', { class: 'segmented', role: 'group', 'aria-label': 'Type de branche' }, scopeButtons),
      ),
      listSlot,
      footerSlot,
    );

    function resetSearch() {
      searchInput.value = '';
      br.query = '';
      br.page = 0;
      clearSearch.hidden = true;
      renderBranchList();
      searchInput.focus();
    }

    async function loadBranches({ fetch = false, manual = false } = {}) {
      if (fetch) { br.fetching = true; UI.setLoading(fetchBtn, true, 'Fetch en cours…'); } else br.loading = true;
      renderBranchHeader();
      if (!br.data) renderBranchList();
      try {
        const data = await window.gitpilot.projects.branches(projectId, { fetch });
        if (destroyed) return;
        br.data = data;
        br.error = null;
        branchCache.set(projectId, data);
        if (fetch && manual) {
          if (data.fetch?.ok) UI.toast('Dépôt actualisé (git fetch).', 'success');
          else if (data.fetch) UI.toast(`git fetch a échoué : ${data.fetch.error}`, 'warning');
        }
      } catch (err) {
        if (destroyed) return;
        br.error = err.message;
        if (manual) UI.toast(err.message, 'danger');
      } finally {
        if (!destroyed) {
          if (fetch) { br.fetching = false; UI.setLoading(fetchBtn, false); } else br.loading = false;
          renderBranchHeader();
          renderBranchList();
        }
      }
    }

    function renderBranchHeader() {
      clear(currentSlot);
      clear(fetchInfo);
      clear(alertSlot);

      if (br.data) {
        const cur = br.data.current;
        currentSlot.append(h('div', { class: 'current-branch', title: 'Branche actuellement extraite (HEAD)' },
          iconEl('branch'), 'Branche courante', h('span', { class: 'name' }, cur.name)));
        branchCount.textContent = String(br.data.branches.length);
      }

      if (br.fetching) {
        fetchInfo.append(h('span', { class: 'spinner' }), 'git fetch en cours…');
      } else if (br.data?.fetch) {
        const f = br.data.fetch;
        fetchInfo.append(iconEl(f.ok ? 'checkCircle' : 'warning'), h('span', { title: formatDate(f.at) }, `Dernier fetch ${formatRelative(f.at)}${f.ok ? '' : ' (échec)'}`));
        fetchInfo.firstChild.style.color = f.ok ? 'var(--green)' : 'var(--amber)';
        if (!f.ok) {
          alertSlot.append(UI.alert('warning', `${f.error} Les branches affichées reflètent le dernier état connu localement.`, 'git fetch a échoué'));
        }
      } else if (br.loading) {
        fetchInfo.append(h('span', { class: 'spinner' }), 'Lecture du dépôt…');
      } else {
        fetchInfo.append(iconEl('info'), 'Aucun fetch effectué pendant cette session');
      }

      if (br.error && br.data) alertSlot.append(UI.alert('danger', br.error, 'Erreur Git'));
    }

    function branchRow(b, query) {
      const typeBadge = b.type === 'local'
        ? h('span', { class: 'badge badge-muted', title: 'Branche locale' }, iconEl('laptop'), 'locale')
        : h('span', { class: 'badge badge-muted', title: `Branche distante (${b.remote})` }, iconEl('cloud'), b.remote);
      return h('div', { class: `list-item ${b.current ? 'is-current' : ''}` },
        iconEl('branch', 'branch-icon'),
        h('div', { class: 'branch-main' },
          h('div', { class: 'branch-title' },
            h('span', { class: 'branch-name', title: b.name }, highlight(b.name, query)),
            b.current ? h('span', { class: 'badge badge-info' }, 'courante') : null,
            typeBadge,
            b.upstream ? h('span', { class: 'muted', style: { fontSize: '12px' }, title: 'Branche suivie (upstream)' }, `→ ${b.upstream}`) : null,
          ),
          h('div', { class: 'branch-meta' },
            h('span', { class: 'sha' }, b.sha),
            h('span', { class: 'sep-dot' }),
            h('span', { class: 'subject', title: b.subject }, b.subject || '(sans message)'),
            b.author ? [h('span', { class: 'sep-dot' }), h('span', { class: 'nowrap' }, b.author)] : null,
          ),
        ),
        h('div', { class: 'branch-date', title: `Dernier commit : ${formatDate(b.date)}` }, formatRelative(b.date)),
      );
    }

    function renderBranchList() {
      for (const btn of scopeButtons) btn.classList.toggle('active', btn.dataset.scope === br.scope);
      clear(listSlot);
      clear(footerSlot);

      if (!br.data) {
        if (br.error) {
          listSlot.append(
            UI.alert('danger', br.error, 'Impossible de lire les branches du dépôt'),
            h('button', { class: 'btn', onclick: () => loadBranches(), html: `${icon('refresh')}<span>Réessayer</span>` }),
          );
        } else {
          listSlot.append(h('div', { class: 'list' }, h('div', { class: 'loading-block' }, h('span', { class: 'spinner spinner-lg' }), 'Chargement des branches…')));
        }
        return;
      }

      const query = br.query.trim();
      const q = query.toLowerCase();
      const all = br.data.branches;
      const scoped = all.filter((b) => br.scope === 'all' || b.type === br.scope);
      // La recherche porte sur l'ensemble des branches du dépôt (pas seulement celles affichées).
      const matches = q ? scoped.filter((b) => b.name.toLowerCase().includes(q)) : scoped;
      const searching = Boolean(q);
      const paged = searching || br.expanded;

      let shown;
      if (paged) {
        const pages = Math.max(1, Math.ceil(matches.length / PAGE_SIZE));
        br.page = Math.min(br.page, pages - 1);
        shown = matches.slice(br.page * PAGE_SIZE, br.page * PAGE_SIZE + PAGE_SIZE);
      } else {
        shown = matches.slice(0, TOP_BRANCHES);
      }

      if (!matches.length) {
        listSlot.append(h('div', { class: 'list' }, h('div', { class: 'empty-inline' },
          searching ? `Aucune branche ne correspond à « ${query} ».` : 'Aucune branche à afficher pour ce filtre.')));
      } else {
        listSlot.append(h('div', { class: 'list' }, shown.map((b) => branchRow(b, query))));
      }

      // Pied de liste : contexte + navigation
      if (paged) {
        const from = matches.length ? br.page * PAGE_SIZE + 1 : 0;
        const to = br.page * PAGE_SIZE + shown.length;
        footerSlot.append(h('span', null, searching
          ? `${matches.length} résultat${matches.length > 1 ? 's' : ''} pour « ${query} » — affichage ${from}–${to}`
          : `Affichage ${from}–${to} sur ${matches.length} branches (triées par date du dernier commit)`));
        const pages = Math.max(1, Math.ceil(matches.length / PAGE_SIZE));
        const pager = h('div', { class: 'pagination' });
        if (pages > 1) {
          pager.append(
            h('button', { class: 'btn btn-sm', disabled: br.page === 0, onclick: () => { br.page -= 1; renderBranchList(); }, html: `${icon('chevronLeft')}<span>Précédent</span>` }),
            h('span', { class: 'muted' }, `Page ${br.page + 1} / ${pages}`),
            h('button', { class: 'btn btn-sm', disabled: br.page >= pages - 1, onclick: () => { br.page += 1; renderBranchList(); }, html: `<span>Suivant</span>${icon('chevronRight')}` }),
          );
        }
        if (!searching) {
          pager.append(h('button', { class: 'btn btn-sm btn-tertiary', onclick: () => { br.expanded = false; br.page = 0; renderBranchList(); }, html: `${icon('chevronUp')}<span>Réduire</span>` }));
        }
        footerSlot.append(pager);
      } else {
        footerSlot.append(h('span', null, `Les ${Math.min(TOP_BRANCHES, matches.length)} branches modifiées le plus récemment sur ${matches.length}`));
        if (matches.length > TOP_BRANCHES) {
          footerSlot.append(h('div', { class: 'pagination' },
            h('button', { class: 'btn btn-sm', onclick: () => { br.expanded = true; br.page = 0; renderBranchList(); }, html: `${icon('chevronDown')}<span>Afficher plus de branches</span>` })));
        }
      }
    }

    /* =====================================================
       Section actions personnalisées
       ===================================================== */
    let selectedRunId = params.run || null;
    const actionsBody = h('div');
    const outputSlot = h('div');

    panelActions.append(
      h('div', { class: 'section-head' },
        h('h2', { class: 'section-title' }, 'Actions'),
        h('span', { class: 'muted', style: { fontSize: '13px' } }, 'Scripts exécutés dans le dossier du projet'),
        h('button', { class: 'btn btn-accent', style: { marginLeft: 'auto' }, onclick: () => openActionModal(project), html: `${icon('plus')}<span>Nouvelle Action</span>` }),
      ),
      actionsBody,
      outputSlot,
    );

    function lastStatusFor(action) {
      const live = State.latestRunFor(projectId, action.id);
      if (live) return { status: live.status, at: live.endedAt || live.startedAt, runId: live.id };
      if (action.lastRun) return { status: action.lastRun.status, at: action.lastRun.endedAt || action.lastRun.startedAt, runId: null };
      return null;
    }

    function renderActions() {
      actionCount.textContent = String(project.actions.length);
      clear(actionsBody);
      if (!project.actions.length) {
        actionsBody.append(h('div', { class: 'empty-state' },
          h('div', { class: 'empty-icon', html: icon('terminal') }),
          h('h3', null, 'Aucune action pour ce projet'),
          h('p', null, 'Une action est un script (commande Git, script shell, build…) exécutable en un clic dans le dossier du projet. Elle reste propre à ce projet.'),
          h('button', { class: 'btn btn-accent', onclick: () => openActionModal(project), html: `${icon('plus')}<span>Créer une action</span>` }),
        ));
        return;
      }

      const rows = project.actions.map((action) => {
        const last = lastStatusFor(action);
        const running = last?.status === 'running';
        const shellTag = action.shell && action.shell !== 'default'
          ? h('span', { class: 'shell-tag', title: 'Shell utilisé' }, shellShortName(action.shell)) : null;

        const statusCell = last
          ? h('button', {
            class: 'status-btn', title: last.runId ? 'Afficher la sortie' : `Dernière exécution : ${formatDate(last.at)}`,
            onclick: (e) => { e.stopPropagation(); if (last.runId) selectRun(last.runId); },
          }, UI.statusBadge(last.status), running ? null : h('span', { class: 'muted', style: { fontSize: '12px', marginLeft: '6px' } }, formatRelative(last.at)))
          : UI.statusBadge(null);

        const runBtn = running
          ? h('button', { class: 'btn btn-sm', title: "Arrêter l'exécution", onclick: (e) => { e.stopPropagation(); cancelRun(last.runId); }, html: `${icon('stop')}<span>Arrêter</span>` })
          : h('button', { class: 'btn btn-sm', title: 'Exécuter cette action', onclick: (e) => { e.stopPropagation(); runAction(action); } }, 'Exécuter');

        const menuBtn = h('button', {
          class: 'btn btn-sm btn-icon', title: 'Options', 'aria-label': 'Options', html: icon('ellipsis'),
          onclick: (e) => {
            e.stopPropagation();
            UI.dropdown(menuBtn, [
              { label: 'Modifier', icon: 'pencil', onClick: () => openActionModal(project, action) },
              last?.runId ? { label: 'Afficher la dernière sortie', icon: 'terminal', onClick: () => selectRun(last.runId) } : null,
              'sep',
              { label: 'Supprimer', icon: 'trash', danger: true, onClick: () => deleteAction(action) },
            ].filter(Boolean));
          },
        });

        const selected = selectedRunId && State.runsFor(projectId).find((r) => r.id === selectedRunId)?.actionId === action.id;
        return h('tr', {
          class: selected ? 'selected' : '',
          ondblclick: () => openActionModal(project, action),
          onclick: () => { const r = State.latestRunFor(projectId, action.id); if (r) selectRun(r.id); },
        },
          h('td', null, h('div', { class: 'action-name' }, h('span', { class: 'ellipsis', title: action.name }, action.name), shellTag)),
          h('td', null, h('div', { class: `action-desc ellipsis ${action.description ? '' : 'empty'}`, title: action.description || '' }, action.description || 'Aucune description')),
          h('td', { class: 'col-last' }, statusCell),
          h('td', { class: 'col-actions' }, h('div', { class: 'row-actions' }, runBtn, menuBtn)),
        );
      });

      actionsBody.append(h('div', { class: 'table-wrap' }, h('table', { class: 'gl-table' },
        h('thead', null, h('tr', null,
          h('th', { style: { width: '28%' } }, 'Action'),
          h('th', null, 'Description'),
          h('th', { class: 'col-last' }, 'Dernière exécution'),
          h('th', { class: 'col-actions' }, h('span', { class: 'hidden' }, 'Commandes')),
        )),
        h('tbody', null, rows),
      )));
    }

    function shellShortName(id) {
      return { system: State.info?.platform === 'win32' ? 'cmd' : 'sh', powershell: 'pwsh', bash: 'bash' }[id] || id;
    }

    async function runAction(action) {
      try {
        const summary = await window.gitpilot.actions.run(projectId, action.id);
        State.trackRun(summary, { live: true });
        selectRun(summary.id);
      } catch (err) {
        UI.toast(err.message, 'danger');
      }
    }

    async function cancelRun(runId) {
      try {
        await window.gitpilot.runs.cancel(runId);
      } catch (err) {
        UI.toast(err.message, 'danger');
      }
    }

    async function deleteAction(action) {
      const ok = await UI.confirm({
        title: "Supprimer l'action",
        message: h('div', null,
          h('p', { style: { marginTop: 0 } }, 'Supprimer définitivement l’action ', h('strong', null, action.name), ' ?'),
          h('p', { class: 'muted', style: { marginBottom: 0 } }, 'Cette opération est irréversible. Le script associé sera perdu.'),
        ),
        confirmLabel: 'Supprimer',
        danger: true,
      });
      if (!ok) return;
      try {
        await window.gitpilot.actions.remove(projectId, action.id);
        project.actions = project.actions.filter((a) => a.id !== action.id);
        State.upsertProject(project);
        UI.toast(`Action « ${action.name} » supprimée.`, 'success');
      } catch (err) {
        UI.toast(err.message, 'danger');
      }
    }

    /* ---------- Panneau de sortie ---------- */
    const terminal = h('div', { class: 'terminal', tabindex: '0', 'aria-label': "Sortie de l'exécution" });
    let stickToBottom = true;
    terminal.addEventListener('scroll', () => {
      stickToBottom = terminal.scrollHeight - terminal.scrollTop - terminal.clientHeight < 24;
    });
    const outTitle = h('div', { class: 'output-title ellipsis' });
    const outStatus = h('div');
    const outMeta = h('div', { class: 'output-meta' });
    const historyBtn = h('button', { class: 'btn btn-sm btn-tertiary', title: 'Historique des exécutions', html: `${icon('clock')}<span>Historique</span>`, onclick: () => openHistory() });
    const copyBtn = h('button', { class: 'btn btn-sm btn-tertiary btn-icon', title: 'Copier la sortie', html: icon('copy'), onclick: () => copyOutput() });
    const bottomBtn = h('button', { class: 'btn btn-sm btn-tertiary btn-icon', title: 'Aller à la fin', html: icon('arrowDown'), onclick: () => { stickToBottom = true; terminal.scrollTop = terminal.scrollHeight; } });

    outputSlot.append(h('div', { class: 'output-panel' },
      h('div', { class: 'output-head' }, outTitle, outStatus, outMeta, h('div', { class: 'output-tools' }, historyBtn, copyBtn, bottomBtn)),
      terminal,
    ));

    function lineEl(entry) {
      return h('div', { class: `line t-${entry.type}` },
        h('span', { class: 'ts' }, `[${formatTime(entry.t)}]`),
        h('span', { class: 'txt' }, entry.text || ' '),
      );
    }

    function renderOutputHeader() {
      const run = selectedRunId ? State.runsFor(projectId).find((r) => r.id === selectedRunId) : null;
      clear(outTitle); clear(outStatus); clear(outMeta);
      if (!run) {
        outTitle.append("Sortie de l'action");
        historyBtn.disabled = !State.runsFor(projectId).length;
        copyBtn.disabled = true;
        return;
      }
      outTitle.append(run.status === 'running' ? "Sortie de l'action en cours : " : "Sortie de l'action : ", h('span', { class: 'name' }, run.actionName));
      outStatus.append(UI.statusBadge(run.status));
      const duration = run.endedAt ? ` · ${formatDuration(run.endedAt - run.startedAt)}` : '';
      outMeta.append(`Lancée à ${formatTime(run.startedAt)}${duration}`);
      outMeta.title = `Répertoire : ${run.cwd}`;
      historyBtn.disabled = false;
      copyBtn.disabled = false;
    }

    function renderOutputBody() {
      clear(terminal);
      const run = selectedRunId ? State.runsFor(projectId).find((r) => r.id === selectedRunId) : null;
      if (!run) {
        terminal.append(h('div', { class: 'placeholder' }, project.actions.length
          ? 'Exécutez une action pour afficher ici sa sortie standard et ses erreurs.'
          : 'Créez une première action pour commencer.'));
        return;
      }
      if (run.truncated) terminal.append(h('div', { class: 'truncated' }, '… début de la sortie tronqué (seules les dernières lignes sont conservées)'));
      const frag = document.createDocumentFragment();
      for (const entry of run.lines || []) frag.append(lineEl(entry));
      terminal.append(frag);
      stickToBottom = true;
      terminal.scrollTop = terminal.scrollHeight;
    }

    async function selectRun(runId) {
      selectedRunId = runId;
      const run = State.runsFor(projectId).find((r) => r.id === runId);
      if (run && !run.linesLoaded) {
        try { await State.loadRun(runId); } catch (err) { UI.toast(err.message, 'danger'); }
        if (destroyed || selectedRunId !== runId) return;
      }
      renderOutputHeader();
      renderOutputBody();
      renderActions();
    }

    function openHistory() {
      const runs = State.runsFor(projectId);
      if (!runs.length) return;
      const items = [{ header: 'Exécutions de cette session' }];
      for (const r of runs.slice(0, 15)) {
        items.push({
          element: h('div', { class: 'run-item', onclick: () => { UI.closeDropdown(); selectRun(r.id); } },
            UI.statusBadge(r.status).firstChild,
            h('div', { style: { minWidth: 0 } },
              h('div', { class: 'title ellipsis' }, r.actionName),
              h('div', { class: 'sub' }, `${formatTime(r.startedAt)}${r.endedAt ? ` · ${formatDuration(r.endedAt - r.startedAt)}` : ' · en cours'}`),
            ),
          ),
        });
      }
      UI.dropdown(historyBtn, items, { className: 'runs-pop' });
    }

    async function copyOutput() {
      const run = State.runsFor(projectId).find((r) => r.id === selectedRunId);
      if (!run) return;
      const text = (run.lines || []).map((l) => `[${formatTime(l.t)}] ${l.type === 'cmd' ? '> ' : ''}${l.text}`).join('\n');
      try {
        await navigator.clipboard.writeText(text);
        UI.toast('Sortie copiée dans le presse-papiers.', 'success');
      } catch {
        UI.toast('Impossible de copier la sortie.', 'danger');
      }
    }

    /* ---------- Abonnements temps réel ---------- */
    cleanups.push(State.on('run-output', ({ runId, lines }) => {
      if (runId !== selectedRunId) return;
      if (terminal.querySelector('.placeholder')) clear(terminal);
      const frag = document.createDocumentFragment();
      for (const entry of lines) frag.append(lineEl(entry));
      terminal.append(frag);
      while (terminal.childElementCount > 5000) terminal.firstElementChild.remove();
      if (stickToBottom) terminal.scrollTop = terminal.scrollHeight;
    }));

    cleanups.push(State.on('run-status', (run) => {
      if (run.projectId !== projectId) return;
      renderActions();
      if (run.id === selectedRunId) renderOutputHeader();
      else if (!selectedRunId) selectRun(run.id);
    }));

    cleanups.push(State.on('projects', () => {
      const fresh = State.getProject(projectId);
      if (fresh && fresh !== project) Object.assign(project, fresh);
      renderActions();
    }));

    /* ---------- Initialisation ---------- */
    setTab(activeTab);
    renderBranchHeader();
    renderBranchList();
    renderActions();

    if (!selectedRunId) selectedRunId = State.runsFor(projectId)[0]?.id || null;
    if (selectedRunId) selectRun(selectedRunId);
    else { renderOutputHeader(); renderOutputBody(); }

    (async () => {
      await loadBranches();
      if (destroyed) return;
      const lastFetch = br.data?.fetch?.at || 0;
      if (State.settings?.fetchOnOpen && Date.now() - lastFetch > AUTO_FETCH_MAX_AGE && !br.error) {
        loadBranches({ fetch: true });
      }
    })();

    // Rafraîchit les dates relatives affichées.
    const ticker = setInterval(() => { if (!br.loading) { renderBranchHeader(); } }, 30_000);
    cleanups.push(() => clearInterval(ticker));

    return () => cleanups.forEach((fn) => fn());
  }

  /* =====================================================
     Modale de création / modification d'action
     ===================================================== */
  function openActionModal(project, action = null) {
    const editing = Boolean(action);
    const shells = State.info?.shells || [];
    const defaultShell = shells.find((s) => s.id === State.settings?.defaultShell);

    const nameInput = h('input', { class: 'input', maxlength: '80', placeholder: 'ex. Déployer Staging', value: action?.name || '', autofocus: true });
    const descInput = h('input', { class: 'input', maxlength: '300', placeholder: 'ex. Build puis déploiement sur l’environnement de staging', value: action?.description || '' });
    const shellSelect = h('select', { class: 'select' },
      h('option', { value: 'default' }, `Par défaut (${defaultShell?.label || 'shell système'})`),
      shells.map((s) => h('option', { value: s.id, disabled: !s.available }, `${s.label}${s.available ? '' : ' — introuvable'}`)),
    );
    shellSelect.value = action?.shell || 'default';

    const scriptInput = h('textarea', { class: 'textarea', rows: '12', spellcheck: 'false', value: action?.script || '' });
    const effectiveShell = () => (shellSelect.value === 'default' ? State.settings?.defaultShell : shellSelect.value);
    const updatePlaceholder = () => {
      scriptInput.placeholder = {
        bash: '# Exemple\ngit fetch --all --prune\nrm -rf dist/\nnpm run build',
        powershell: "# Exemple\ngit fetch --all --prune\nRemove-Item -Recurse -Force dist -ErrorAction SilentlyContinue\nnpm run build",
        system: State.info?.platform === 'win32'
          ? 'REM Exemple\ngit fetch --all --prune\nif exist dist rmdir /s /q dist\nnpm run build'
          : '# Exemple\ngit fetch --all --prune\nrm -rf dist/\nnpm run build',
      }[effectiveShell()] || '';
    };
    shellSelect.addEventListener('change', updatePlaceholder);
    updatePlaceholder();

    // Tabulation = indentation dans l'éditeur de script.
    scriptInput.addEventListener('keydown', (e) => {
      if (e.key === 'Tab' && !e.shiftKey) {
        e.preventDefault();
        document.execCommand('insertText', false, '  ');
      }
    });

    const errorBox = h('div');
    const submitBtn = h('button', { class: 'btn btn-accent', type: 'submit', form: 'action-form' }, editing ? 'Enregistrer' : "Créer l'action");
    const form = h('form', { id: 'action-form', novalidate: true },
      errorBox,
      h('div', { class: 'field' }, h('label', null, 'Nom'), nameInput),
      h('div', { class: 'field' }, h('label', null, 'Description ', h('span', { class: 'optional' }, '(facultative)')), descInput),
      h('div', { class: 'field' },
        h('label', null, 'Shell'),
        shellSelect,
      ),
      h('div', { class: 'field', style: { marginBottom: 0 } },
        h('label', null, 'Script'),
        scriptInput,
        h('div', { class: 'hint' },
          'Exécuté dans ', h('code', null, project.path),
          '. Aucune saisie interactive possible. Variables disponibles : ',
          h('code', null, 'GITPILOT_PROJECT_PATH'), ', ', h('code', null, 'GITPILOT_PROJECT_NAME'), '.'),
      ),
    );

    const m = UI.modal({
      title: editing ? `Modifier l'action « ${action.name} »` : 'Nouvelle action',
      size: 'lg',
      body: form,
      footer: [
        h('div', { class: 'left' }, h('kbd', { class: 'mono' }, 'Ctrl+Entrée'), 'pour enregistrer'),
        h('button', { class: 'btn', type: 'button', onclick: () => m.tryClose() }, 'Annuler'),
        submitBtn,
      ],
    });

    form.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); form.requestSubmit(); }
    });

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      clear(errorBox);
      const input = { name: nameInput.value, description: descInput.value, script: scriptInput.value, shell: shellSelect.value };
      if (!input.name.trim()) { errorBox.append(UI.alert('danger', "Le nom de l'action est obligatoire.")); nameInput.focus(); return; }
      if (!input.script.trim()) { errorBox.append(UI.alert('danger', 'Le script ne peut pas être vide.')); scriptInput.focus(); return; }

      m.busy = true;
      UI.setLoading(submitBtn, true, 'Enregistrement…');
      try {
        const saved = editing
          ? await window.gitpilot.actions.update(project.id, action.id, input)
          : await window.gitpilot.actions.create(project.id, input);
        const fresh = State.getProject(project.id) || project;
        const i = fresh.actions.findIndex((a) => a.id === saved.id);
        if (i === -1) fresh.actions.push(saved); else fresh.actions[i] = saved;
        State.upsertProject(fresh);
        m.busy = false;
        m.close();
        UI.toast(editing ? 'Action mise à jour.' : `Action « ${saved.name} » créée.`, 'success');
      } catch (err) {
        m.busy = false;
        UI.setLoading(submitBtn, false);
        errorBox.append(UI.alert('danger', err.message));
      }
    });
  }

  return { mount, openActionModal };
})();
