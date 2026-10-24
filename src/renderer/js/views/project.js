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

    const fetchBtn = h('button', { class: 'btn', title: 'git fetch --all --prune puis rechargement des branches', html: `${icon('refresh')}<span>Actualiser</span>`, onclick: () => loadBranches({ fetch: true, manual: true }) });
    const currentSlot = h('div');
    const folderBtn = h('button', { class: 'btn', title: 'Ouvrir le dossier du projet', html: `${icon('folder')}<span>Ouvrir</span>`, onclick: () => HomeView.openFolder(project) });
    const removeBtn = h('button', { class: 'btn btn-danger', title: 'Retirer du dashboard', html: `${icon('trash')}<span>Retirer</span>`, onclick: () => HomeView.removeProject(project) });

    const branchCount = h('span', { class: 'count-badge' }, '…');
    const actionCount = h('span', { class: 'count-badge' }, String(project.actions.length));
    const mrLabel = h('span', null, 'Merge requests');
    const tabMr = h('button', { class: 'tab', role: 'tab', onclick: () => setTab('mr') }, mrLabel);
    const panelMr = h('section', { role: 'tabpanel', 'aria-label': 'Merge requests' });
    let mrTab = null; // monté au premier affichage de l'onglet
    const tabBranches = h('button', { class: 'tab', role: 'tab', onclick: () => setTab('branches') }, 'Branches', branchCount);
    const tabActions = h('button', { class: 'tab', role: 'tab', onclick: () => setTab('actions') }, 'Actions', actionCount);
    const panelBranches = h('section', { role: 'tabpanel', 'aria-label': 'Informations et branches Git' });
    const panelActions = h('section', { role: 'tabpanel', 'aria-label': 'Actions personnalisées' });

    root.append(h('div', { class: 'page' },
      h('div', { class: 'page-header' },
        h('div', { style: { minWidth: 0 } },
          h('h1', { class: 'page-title ellipsis' }, project.name),
          currentSlot,
        ),
        h('div', { class: 'page-actions' }, fetchBtn, folderBtn, removeBtn),
      ),
      h('div', { class: 'tabs', role: 'tablist' }, tabMr, tabBranches, tabActions),
      panelMr,
      panelBranches,
      panelActions,
    ));

    function setTab(tab) {
      activeTab = ['mr', 'actions'].includes(tab) ? tab : 'branches';
      prefs.set(`tab.${projectId}`, activeTab);
      for (const [name, button, panel] of [['mr', tabMr, panelMr], ['branches', tabBranches, panelBranches], ['actions', tabActions, panelActions]]) {
        button.classList.toggle('active', activeTab === name);
        button.setAttribute('aria-selected', String(activeTab === name));
        panel.hidden = activeTab !== name;
      }
      if (activeTab === 'mr' && !mrTab) {
        mrTab = MergeRequestsView.mountTab(panelMr, project, {
          onProvider: (provider) => { mrLabel.textContent = provider === 'github' ? 'Pull requests' : 'Merge requests'; },
        });
        cleanups.push(() => mrTab.destroy());
      }
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
      selecting: false, // mode sélection multiple (suppression groupée)
      selected: new Set(), // refs sélectionnées
      deleting: false,
    };

    const fetchInfo = h('div', { class: 'inline-spinner', style: { marginLeft: 'auto' } });
    const protSlot = h('div', { class: 'prot-info' });
    let protection = null; // réponse de projects:protection
    let protectedRefs = new Set();
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
    const selectBtn = h('button', {
      class: 'btn', type: 'button', title: 'Sélectionner plusieurs branches à supprimer',
      html: `${icon('checkCircle')}<span>Sélectionner</span>`,
      onclick: () => setSelecting(!br.selecting),
    });
    const selectionBar = h('div', { class: 'selection-bar', hidden: true, role: 'region', 'aria-label': 'Sélection de branches' });

    panelBranches.append(
      h('div', { class: 'toolbar' }, protSlot, fetchInfo),
      alertSlot,
      h('div', { class: 'toolbar' },
        h('div', { class: 'search-box' }, iconEl('search'), searchInput, clearSearch),
        h('div', { class: 'segmented', role: 'group', 'aria-label': 'Type de branche' }, scopeButtons),
        selectBtn,
      ),
      listSlot,
      footerSlot,
      selectionBar,
    );

    /* ---------- Sélection multiple ---------- */
    const isDeletable = (b) => !b.current && !b.isDefault && !protectedRefs.has(b.ref);
    const notDeletableReason = (b) => {
      if (b.isDefault) return 'Branche principale : suppression interdite';
      if (b.current) return 'Branche courante : suppression impossible';
      return 'Branche protégée : suppression impossible';
    };

    function setSelecting(on) {
      br.selecting = on;
      br.selected.clear();
      selectBtn.classList.toggle('active', on);
      renderBranchList();
    }

    function toggleSelected(b) {
      if (!isDeletable(b) || br.deleting) return;
      if (br.selected.has(b.ref)) br.selected.delete(b.ref);
      else br.selected.add(b.ref);
      renderBranchList();
    }

    function renderSelectionBar(matches) {
      clear(selectionBar);
      selectionBar.hidden = !br.selecting;
      if (!br.selecting) return;
      // Les branches sélectionnées qui ont disparu (suppression, fetch) sont oubliées.
      const known = new Set(br.data.branches.filter(isDeletable).map((b) => b.ref));
      for (const ref of [...br.selected]) if (!known.has(ref)) br.selected.delete(ref);

      const n = br.selected.size;
      const selectable = matches.filter(isDeletable);
      const allSelected = selectable.length > 0 && selectable.every((b) => br.selected.has(b.ref));
      const deleteBtn = h('button', {
        class: 'btn btn-danger', type: 'button', disabled: !n || br.deleting,
        html: `${icon('trash')}<span>Supprimer${n ? ` (${n})` : ''}</span>`,
        onclick: () => deleteSelected(),
      });
      if (br.deleting) UI.setLoading(deleteBtn, true, 'Suppression…');
      selectionBar.append(
        h('span', { class: 'selection-count' }, n ? `${n} branche${n > 1 ? 's' : ''} sélectionnée${n > 1 ? 's' : ''}` : 'Cochez les branches à supprimer'),
        selectable.length ? h('button', {
          class: 'btn-link', type: 'button', disabled: br.deleting,
          onclick: () => {
            for (const b of selectable) { if (allSelected) br.selected.delete(b.ref); else br.selected.add(b.ref); }
            renderBranchList();
          },
        }, allSelected ? 'Tout désélectionner' : `Tout sélectionner (${selectable.length})`) : null,
        h('div', { class: 'selection-actions' },
          h('button', { class: 'btn', type: 'button', disabled: br.deleting, onclick: () => setSelecting(false) }, 'Annuler'),
          deleteBtn,
        ),
      );
    }

    async function deleteSelected() {
      const targets = br.data.branches.filter((b) => br.selected.has(b.ref) && isDeletable(b));
      if (!targets.length) return;
      const locals = targets.filter((b) => b.type === 'local');
      const remotes = targets.filter((b) => b.type === 'remote');
      const forceCheck = h('input', { type: 'checkbox' });
      const ok = await UI.confirm({
        title: `Supprimer ${targets.length} branche${targets.length > 1 ? 's' : ''}`,
        message: h('div', null,
          h('div', { class: 'bulk-list' }, targets.map((b) => h('div', { class: 'bulk-item' },
            iconEl(b.type === 'local' ? 'laptop' : 'cloud'),
            h('span', { class: 'mono ellipsis' }, b.name),
            h('span', { class: 'muted', style: { marginLeft: 'auto', fontSize: '12px' } }, b.type === 'local' ? 'locale' : 'distante'),
          ))),
          remotes.length
            ? UI.alert('warning', `${remotes.length} branche${remotes.length > 1 ? 's distantes seront supprimées' : ' distante sera supprimée'} sur le serveur (git push --delete), pour tous les utilisateurs. Cette opération est irréversible depuis GitPilot.`)
            : null,
          locals.length ? h('label', { class: 'checkbox', style: { marginTop: '12px' } }, forceCheck,
            h('span', null, 'Forcer la suppression des branches locales (git branch -D)',
              h('div', { class: 'hint', style: { margin: 0 } }, 'Sinon, Git refuse de supprimer une branche dont les commits ne sont pas fusionnés.'))) : null,
        ),
        confirmLabel: `Supprimer ${targets.length}`,
        danger: true,
      });
      if (!ok) return;

      br.deleting = true;
      renderBranchList();
      const failures = [];
      for (const b of targets) {
        try {
          await window.gitpilot.projects.deleteBranch(projectId, { ref: b.ref, force: forceCheck.checked });
        } catch (err) {
          failures.push({ b, err });
        }
        if (destroyed) return;
      }
      br.deleting = false;
      const done = targets.length - failures.length;
      if (done) UI.toast(`${done} branche${done > 1 ? 's supprimées' : ' supprimée'}.`, 'success');
      if (failures.length) {
        const first = failures[0];
        UI.toast(`${failures.length} suppression${failures.length > 1 ? 's' : ''} en échec. ${first.b.name} : ${first.err.message}`, 'danger', { timeout: 15000 });
      }
      br.selecting = false;
      br.selected.clear();
      selectBtn.classList.remove('active');
      loadBranches();
    }

    function resetSearch() {
      searchInput.value = '';
      br.query = '';
      br.page = 0;
      clearSearch.hidden = true;
      renderBranchList();
      searchInput.focus();
    }

    async function loadBranches({ fetch = false, manual = false } = {}) {
      if (fetch) { br.fetching = true; UI.setLoading(fetchBtn, true, 'Actualisation…'); } else br.loading = true;
      renderBranchHeader();
      if (!br.data) renderBranchList();
      try {
        const data = await window.gitpilot.projects.branches(projectId, { fetch });
        if (destroyed) return;
        br.data = data;
        br.error = null;
        branchCache.set(projectId, data);
        loadProtection({ refresh: fetch });
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

    async function loadProtection({ refresh = false } = {}) {
      try {
        protection = await window.gitpilot.projects.protection(projectId, { refresh });
      } catch (err) {
        protection = { status: 'error', error: err.message };
      }
      if (destroyed) return;
      protectedRefs = new Set();
      if (protection.status === 'ok') {
        const prefix = `${protection.remote}/`;
        for (const b of br.data?.branches || []) {
          if (b.type === 'remote' && b.remote === protection.remote && protection.branches.includes(b.name.slice(prefix.length))) {
            protectedRefs.add(b.ref);
          }
        }
      }
      renderProtection();
      renderBranchList();
    }

    function renderProtection() {
      clear(protSlot);
      if (!protection) return;
      const connect = (label) => h('button', {
        class: 'btn-link', type: 'button',
        onclick: () => Accounts.openConnectModal(protection.host),
      }, label);
      if (protection.status === 'disconnected') {
        protSlot.append(iconEl('lock'), 'Branches protégées : ', connect(`connecter ${protection.host}`));
      } else if (protection.status === 'error') {
        protSlot.append(iconEl('warning'), h('span', { class: 'ellipsis', title: protection.error }, protection.error));
        if (protection.host) protSlot.append(connect('reconnecter'));
        protSlot.firstChild.style.color = 'var(--amber)';
      } else if (protection.status === 'ok') {
        const n = protectedRefs.size;
        protSlot.append(iconEl('lock'), h('span', { title: `Informations lues sur ${protection.host}` },
          `${n} branche${n > 1 ? 's' : ''} protégée${n > 1 ? 's' : ''}`));
      }
    }

    function renderBranchHeader() {
      clear(currentSlot);
      clear(fetchInfo);
      clear(alertSlot);

      if (br.data) {
        const cur = br.data.current;
        currentSlot.append(h('div', { class: 'current-branch', title: 'Branche actuellement extraite (HEAD)' },
          iconEl('branch'), h('span', null, 'Branche courante'), h('span', { class: 'name' }, cur.name)));
        branchCount.textContent = String(br.data.branches.length);
      }

      if (br.fetching) {
        fetchInfo.append(h('span', { class: 'spinner' }), 'git fetch en cours…');
      } else if (br.data?.fetch) {
        const f = br.data.fetch;
        fetchInfo.append(iconEl(f.ok ? 'checkCircle' : 'warning'), h('span', { title: formatDate(f.at) }, `Dernier fetch ${formatRelative(f.at)}${f.ok ? '' : ' (échec)'}`));
        fetchInfo.firstChild.style.color = f.ok ? 'var(--green)' : 'var(--amber)';
        if (!f.ok) {
          alertSlot.append(UI.alert('warning', [
            `${f.error} Les branches affichées reflètent le dernier état connu localement.`,
            f.kind === 'ssh-auth'
              ? h('div', { style: { marginTop: '10px' } }, h('button', {
                class: 'btn btn-sm', type: 'button', html: `${icon('lock')}<span>Configurer l’accès SSH</span>`,
                onclick: () => SshSetup.open(project),
              }))
              : null,
          ], 'git fetch a échoué'));
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
      const deletable = isDeletable(b);
      const selected = br.selected.has(b.ref);
      let lead = iconEl('branch', 'branch-icon');
      if (br.selecting) {
        lead = h('input', { type: 'checkbox', class: 'branch-check', 'aria-label': `Sélectionner ${b.name}`, disabled: !deletable || br.deleting });
        lead.checked = selected;
        if (!deletable) lead.title = notDeletableReason(b);
        lead.addEventListener('click', (e) => { e.stopPropagation(); toggleSelected(b); });
      }
      return h('div', {
        class: `list-item branch-row ${b.current ? 'is-current' : ''} ${selected ? 'is-selected' : ''} ${br.selecting && !deletable ? 'is-locked' : ''}`,
        onclick: () => {
          if (br.selecting) toggleSelected(b);
          else App.navigate(`/project/${projectId}/commits?ref=${encodeURIComponent(b.ref)}`);
        },
      },
        lead,
        h('div', { class: 'branch-main' },
          h('div', { class: 'branch-title' },
            h('span', { class: 'branch-name' }, highlight(b.name, query)),
            b.current ? h('span', { class: 'badge badge-success' }, 'courante') : null,
            typeBadge,
            protectedRefs.has(b.ref)
              ? h('span', { class: 'badge badge-protected', title: 'Branche protégée' }, iconEl('lock'), 'protected')
              : null,
            b.upstream ? h('span', { class: 'muted', style: { fontSize: '12px' }, title: 'Branche suivie (upstream)' }, `→ ${b.upstream}`) : null,
          ),
          h('div', { class: 'branch-meta' },
            h('span', { class: 'sha' }, b.sha),
            h('span', { class: 'sep-dot' }),
            h('span', { class: 'subject' }, b.subject || '(sans message)'),
            b.author ? [h('span', { class: 'sep-dot' }), h('span', { class: 'nowrap' }, b.author)] : null,
          ),
        ),
        h('div', { class: 'branch-date', title: `Dernier commit : ${formatDate(b.date)}` }, formatRelative(b.date)),
        br.selecting ? null : h('div', { class: 'branch-actions' },
          b.current ? null : h('button', {
            class: 'btn btn-sm btn-icon btn-tertiary', title: 'Basculer sur cette branche (checkout)', html: icon('switch'),
            onclick: (e) => { e.stopPropagation(); checkout(b); },
          }),
          protection && protection.status !== 'none' && !b.isDefault ? h('button', {
            class: 'btn btn-sm btn-icon btn-tertiary', title: protection.provider === 'github' ? 'Créer une pull request' : 'Créer une merge request', html: icon('pullRequest'),
            onclick: (e) => { e.stopPropagation(); MergeRequestsView.openCreateModal(project, b.ref); },
          }) : null,
          h('button', {
          class: 'btn btn-sm btn-icon btn-tertiary branch-delete',
          title: isDeletable(b) ? 'Supprimer la branche' : notDeletableReason(b),
          disabled: !isDeletable(b),
          html: icon('trash'),
          onclick: (e) => { e.stopPropagation(); deleteBranch(b); },
        })),
      );
    }

    /* ---------- Checkout ---------- */
    async function checkout(b) {
      let status;
      try {
        status = await window.gitpilot.git.status(projectId);
      } catch (err) {
        UI.toast(err.message, 'danger');
        return;
      }
      if (status.count) openDirtyModal(b, status);
      else await doCheckout(b, null);
    }

    async function doCheckout(b, prepare) {
      const res = await window.gitpilot.git.checkout(projectId, { ref: b.ref, prepare }).catch((err) => {
        UI.toast(err.message, 'danger', { timeout: 12000 });
        return null;
      });
      if (!res) return false;
      const extra = { stash: ' Vos modifications ont été mises de côté (stash).', commit: ' Vos modifications ont été commitées.' }[res.prepared] || '';
      UI.toast(`Vous êtes sur la branche « ${res.branch} ».${extra}`, 'success');
      loadBranches();
      return true;
    }

    /** Modifications non commitées : commit ou stash -u, avec un message, avant de basculer. */
    function openDirtyModal(b, status) {
      const current = br.data?.current?.name || 'HEAD';
      const target = b.type === 'remote' ? b.name.slice(b.remote.length + 1) : b.name;
      let mode = 'commit';
      const messageInput = h('input', { class: 'input', maxlength: '500', spellcheck: 'false' });
      const messageLabel = h('label', { for: 'dirty-message' });
      messageInput.id = 'dirty-message';
      const submitBtn = h('button', { class: 'btn btn-accent', type: 'submit', form: 'dirty-form' });
      const errorBox = h('div');

      const choice = (value, iconName, title, sub) => {
        const radio = h('input', { type: 'radio', name: 'dirty-mode', value, class: 'sr-only' });
        radio.checked = value === mode;
        radio.addEventListener('change', () => { mode = value; sync(); messageInput.focus(); });
        return h('label', { class: 'provider-card choice-card', dataset: { mode: value } },
          radio,
          h('span', { class: 'choice-icon', html: icon(iconName) }),
          h('span', { class: 'provider-text' }, h('span', { class: 'provider-title' }, title), h('span', { class: 'provider-sub' }, sub)),
          h('span', { class: 'provider-check', html: icon('checkCircle') }),
        );
      };
      const cards = h('div', { class: 'provider-cards' },
        choice('commit', 'commit', 'Commiter', `Tout enregistrer dans un commit sur « ${current} »`),
        choice('stash', 'archive', 'Mettre de côté', 'git stash -u : récupérable plus tard'),
      );

      function sync() {
        for (const el of cards.children) el.classList.toggle('selected', el.dataset.mode === mode);
        messageLabel.textContent = mode === 'commit' ? 'Message du commit' : 'Message du stash';
        messageInput.placeholder = `${current} ${mode}`;
        submitBtn.textContent = mode === 'commit' ? 'Commiter et basculer' : 'Mettre de côté et basculer';
      }

      const shown = status.files.slice(0, 8);
      const form = h('form', { id: 'dirty-form', novalidate: true },
        errorBox,
        h('p', { style: { marginTop: 0 } },
          'La branche ', h('strong', { class: 'mono' }, current), ` contient ${status.count} modification${status.count > 1 ? 's' : ''} non commitée${status.count > 1 ? 's' : ''}. Que faire avant de basculer sur `,
          h('strong', { class: 'mono' }, target), ' ?'),
        h('div', { class: 'dirty-files' },
          shown.map((f) => h('div', { class: 'dirty-file' }, h('span', { class: 'dirty-code mono' }, f.code), h('span', { class: 'mono ellipsis' }, f.path))),
          status.count > shown.length ? h('div', { class: 'muted', style: { fontSize: '12px', padding: '4px 8px' } }, `… et ${status.count - shown.length} autre(s)`) : null,
        ),
        cards,
        h('div', { class: 'field', style: { marginBottom: 0 } },
          messageLabel, messageInput,
          h('div', { class: 'hint' }, 'Laissé vide, le texte grisé est utilisé.')),
      );
      sync();

      const m = UI.modal({
        title: 'Modifications non commitées',
        body: form,
        footer: [h('button', { class: 'btn', type: 'button', onclick: () => m.tryClose() }, 'Annuler'), submitBtn],
      });
      requestAnimationFrame(() => requestAnimationFrame(() => messageInput.focus()));

      form.addEventListener('submit', async (e) => {
        e.preventDefault();
        clear(errorBox);
        const message = messageInput.value.trim() || messageInput.placeholder;
        m.busy = true;
        UI.setLoading(submitBtn, true, mode === 'commit' ? 'Commit…' : 'Stash…');
        try {
          const res = await window.gitpilot.git.checkout(projectId, { ref: b.ref, prepare: { mode, message } });
          m.busy = false;
          m.close();
          const extra = res.prepared === 'stash' ? ' Vos modifications ont été mises de côté (stash).' : ' Vos modifications ont été commitées.';
          UI.toast(`Vous êtes sur la branche « ${res.branch} ».${extra}`, 'success');
          loadBranches();
        } catch (err) {
          m.busy = false;
          UI.setLoading(submitBtn, false);
          sync();
          errorBox.append(UI.alert('danger', err.message));
        }
      });
    }

    async function deleteBranch(b) {
      const remote = b.type === 'remote';
      const forceCheck = h('input', { type: 'checkbox' });
      const ok = await UI.confirm({
        title: remote ? 'Supprimer la branche distante' : 'Supprimer la branche locale',
        message: h('div', null,
          h('p', { style: { marginTop: 0 } }, 'Supprimer la branche ', h('strong', { class: 'mono' }, b.name), ' ?'),
          remote
            ? UI.alert('warning', `La branche sera supprimée sur le dépôt distant « ${b.remote} » (git push --delete), pour tous les utilisateurs. Cette opération est irréversible depuis GitPilot.`)
            : h('p', { class: 'muted' }, 'Par défaut, Git refuse de supprimer une branche dont les commits ne sont pas fusionnés.'),
          remote ? null : h('label', { class: 'checkbox' }, forceCheck,
            h('span', null, 'Forcer la suppression (git branch -D)',
              h('div', { class: 'hint', style: { margin: 0 } }, 'Supprime la branche même si elle contient des commits non fusionnés, qui seront perdus.'))),
        ),
        confirmLabel: 'Supprimer',
        danger: true,
      });
      if (!ok) return;
      try {
        await window.gitpilot.projects.deleteBranch(projectId, { ref: b.ref, force: forceCheck.checked });
        UI.toast(`Branche « ${b.name} » supprimée.`, 'success');
      } catch (err) {
        UI.toast(err.message, 'danger', { timeout: 12000 });
      }
      loadBranches();
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
      // Branches principales (main / master) et protégées en tête ; le tri est stable,
      // l'ordre par date du dernier commit est donc conservé dans chaque groupe.
      const isPriority = (b) => b.isDefault || protectedRefs.has(b.ref);
      const all = [...br.data.branches].sort((a, b) => Number(isPriority(b)) - Number(isPriority(a)));
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

      selectBtn.disabled = !br.data.branches.some(isDeletable);
      renderSelectionBar(matches);

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
          : `Affichage ${from}–${to} sur ${matches.length} branches (principales et protégées d'abord, puis par date du dernier commit)`));
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
    const schedulesSlot = h('div');
    const outputSlot = h('div');
    const copyActionsBtn = h('button', { class: 'btn', title: "Copier des actions vers d'autres projets", onclick: () => openCopyModal(project), html: `${icon('copy')}<span>Copier vers…</span>` });
    const exportBtn = h('button', { class: 'btn', title: 'Exporter des actions dans un fichier (.gitpilot.json)', onclick: () => openExportModal(project), html: `${icon('download')}<span>Exporter</span>` });
    const importBtn = h('button', { class: 'btn', title: 'Importer des actions depuis un fichier (.gitpilot.json)', onclick: () => importActions(project), html: `${icon('upload')}<span>Importer</span>` });

    panelActions.append(
      h('div', { class: 'section-head' },
        h('h2', { class: 'section-title' }, 'Actions'),
        h('span', { class: 'muted', style: { fontSize: '13px' } }, 'Scripts exécutés dans le dossier du projet'),
        h('div', { class: 'section-actions' },
          importBtn,
          exportBtn,
          copyActionsBtn,
          h('button', { class: 'btn btn-accent', onclick: () => openActionModal(project), html: `${icon('plus')}<span>Nouvelle Action</span>` }),
        ),
      ),
      actionsBody,
      schedulesSlot,
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
      copyActionsBtn.disabled = !project.actions.length || State.projects.length < 2;
      exportBtn.disabled = !project.actions.length;
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
          ? h('button', { class: 'btn btn-sm btn-icon', title: "Arrêter l'exécution", 'aria-label': "Arrêter l'exécution", html: icon('stop'), onclick: (e) => { e.stopPropagation(); cancelRun(last.runId); } })
          : h('button', { class: 'btn btn-sm btn-icon', title: 'Exécuter cette action', 'aria-label': 'Exécuter cette action', html: icon('play'), onclick: (e) => { e.stopPropagation(); runAction(action); } });
        const scheduleBtn = h('button', {
          class: 'btn btn-sm btn-icon', title: "Programmer l'exécution", 'aria-label': "Programmer l'exécution", html: icon('clock'),
          onclick: (e) => { e.stopPropagation(); openScheduleModal(project, action); },
        });
        const pending = State.schedulesFor(projectId, action.id).filter((sc) => sc.status === 'pending');
        const scheduleTag = pending.length
          ? h('span', {
            class: 'badge badge-info schedule-tag',
            title: `Programmée : ${pending.map((sc) => formatDate(sc.runAt)).join(', ')}`,
          }, iconEl('clock'), pending.length > 1 ? `${pending.length}` : formatShortDate(pending[0].runAt))
          : null;
        const editBtn = h('button', {
          class: 'btn btn-sm btn-icon', title: "Modifier l'action", 'aria-label': "Modifier l'action", html: icon('pencil'),
          onclick: (e) => { e.stopPropagation(); openActionModal(project, action); },
        });
        const deleteBtn = h('button', {
          class: 'btn btn-sm btn-icon btn-danger', title: "Supprimer l'action", 'aria-label': "Supprimer l'action", html: icon('trash'),
          onclick: (e) => { e.stopPropagation(); deleteAction(action); },
        });

        const selected = selectedRunId && State.runsFor(projectId).find((r) => r.id === selectedRunId)?.actionId === action.id;
        return h('tr', {
          class: selected ? 'selected' : '',
          onclick: () => openScriptView(project, action),
        },
          h('td', null, h('div', { class: 'action-name' }, h('span', { class: 'ellipsis', title: action.name }, action.name), shellTag, scheduleTag)),
          h('td', null, h('div', { class: `action-desc ellipsis ${action.description ? '' : 'empty'}`, title: action.description || '' }, action.description || 'Aucune description')),
          h('td', { class: 'col-last' }, statusCell),
          h('td', { class: 'col-actions' }, h('div', { class: 'row-actions' }, h('div', { class: 'btn-group' }, runBtn, scheduleBtn, editBtn, deleteBtn))),
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

    function renderSchedules() {
      clear(schedulesSlot);
      const list = State.schedulesFor(projectId);
      if (!list.length) return;
      const rows = list.map((sc) => {
        const action = project.actions.find((a) => a.id === sc.actionId);
        const status = {
          pending: h('span', { class: 'status status-running' }, iconEl('clock'), 'Prévue'),
          missed: h('span', { class: 'status status-cancelled', title: sc.error || '' }, iconEl('warning'), 'Manquée'),
          failed: h('span', { class: 'status status-error', title: sc.error || '' }, iconEl('xCircle'), 'Non lancée'),
        }[sc.status];
        const label = sc.status === 'pending' ? 'Annuler la programmation' : 'Retirer de la liste';
        return h('div', { class: 'list-item schedule-item' },
          status,
          h('span', { class: 'schedule-action ellipsis' }, action?.name || 'Action supprimée'),
          h('span', { class: 'muted', title: formatDate(sc.runAt) }, `${formatDate(sc.runAt)} · ${formatRelative(sc.runAt)}`),
          sc.status !== 'pending' && sc.error ? h('span', { class: 'muted ellipsis schedule-error' }, sc.error) : null,
          h('button', {
            class: 'btn btn-sm btn-icon btn-tertiary', style: { marginLeft: 'auto' }, title: label, 'aria-label': label, html: icon('close'),
            onclick: () => cancelSchedule(sc),
          }),
        );
      });
      schedulesSlot.append(
        h('h3', { class: 'subsection-title' }, 'Exécutions programmées'),
        h('div', { class: 'list' }, rows),
        h('div', { class: 'muted', style: { fontSize: '12px', marginTop: '6px' } },
          "Les programmations ne s'exécutent que si GitPilot est ouvert à l'heure prévue."),
      );
    }

    async function cancelSchedule(sc) {
      try {
        await window.gitpilot.schedules.cancel(sc.id);
      } catch (err) {
        UI.toast(err.message, 'danger');
      }
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
          h('p', { class: 'muted', style: { marginBottom: 0 } }, 'Cette opération est irréversible. Le script associé sera perdu.',
            State.schedulesFor(projectId, action.id).length ? ' Ses exécutions programmées seront annulées.' : ''),
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
      return h('div', { class: `line t-${entry.type}${entry.level ? ` lvl-${entry.level}` : ''}` },
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

    cleanups.push(State.on('schedules', () => { renderActions(); renderSchedules(); }));
    cleanups.push(State.on('accounts', () => loadProtection({ refresh: true })));
    cleanups.push(State.on('ssh', () => loadBranches({ fetch: true, manual: true })));

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
    renderSchedules();

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
    const ticker = setInterval(() => { if (!br.loading) { renderBranchHeader(); } renderSchedules(); }, 30_000);
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
          'Exécuté dans le dossier du projet. Aucune saisie interactive possible. Variables disponibles : ',
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

  /* =====================================================
     Modale de programmation d'une exécution
     ===================================================== */
  function toLocalInput(ts) {
    const d = new Date(ts);
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }

  function openScheduleModal(project, action) {
    const FIVE_MIN = 5 * 60 * 1000;
    const inOneHour = Math.ceil((Date.now() + 3600 * 1000) / FIVE_MIN) * FIVE_MIN;
    const dateInput = h('input', { class: 'input', type: 'datetime-local', value: toLocalInput(inOneHour), min: toLocalInput(Date.now()), style: { maxWidth: '240px' } });
    const tomorrow9 = () => { const d = new Date(); d.setDate(d.getDate() + 1); d.setHours(9, 0, 0, 0); return d.getTime(); };
    const preset = (label, ts) => h('button', { class: 'btn btn-sm', type: 'button', onclick: () => { dateInput.value = toLocalInput(ts()); } }, label);

    const errorBox = h('div');
    const submitBtn = h('button', { class: 'btn btn-accent', type: 'submit', form: 'schedule-form' }, 'Programmer');
    const form = h('form', { id: 'schedule-form', novalidate: true },
      errorBox,
      h('div', { class: 'field' },
        h('label', null, "Date et heure d'exécution"),
        dateInput,
        h('div', { class: 'preset-row' },
          preset('Dans 15 min', () => Date.now() + 15 * 60 * 1000),
          preset('Dans 1 h', () => Date.now() + 3600 * 1000),
          preset('Demain 9 h', tomorrow9),
        ),
      ),
      h('div', { class: 'muted', style: { fontSize: '13px' } },
        "GitPilot doit être ouvert à l'heure prévue. Une programmation dont l'heure est passée pendant que l'application était fermée n'est pas exécutée : elle est signalée comme manquée."),
    );

    const m = UI.modal({
      title: `Programmer « ${action.name} »`,
      body: form,
      footer: [h('button', { class: 'btn', type: 'button', onclick: () => m.tryClose() }, 'Annuler'), submitBtn],
    });

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      clear(errorBox);
      const runAt = dateInput.value ? new Date(dateInput.value).getTime() : NaN;
      if (!Number.isFinite(runAt)) { errorBox.append(UI.alert('danger', 'Indiquez une date et une heure.')); return; }
      if (runAt <= Date.now()) { errorBox.append(UI.alert('danger', 'La date doit être dans le futur.')); return; }
      m.busy = true;
      UI.setLoading(submitBtn, true, 'Enregistrement…');
      try {
        await window.gitpilot.schedules.create(project.id, action.id, runAt);
        m.busy = false;
        m.close();
        UI.toast(`« ${action.name} » programmée le ${formatDate(runAt)}.`, 'success');
      } catch (err) {
        m.busy = false;
        UI.setLoading(submitBtn, false);
        errorBox.append(UI.alert('danger', err.message));
      }
    });
  }

  /* =====================================================
     Listes à cocher (copie, export, import)
     ===================================================== */
  function check(checked) {
    const c = h('input', { type: 'checkbox' });
    c.checked = checked;
    return c;
  }

  function checkList(items) {
    return h('div', { class: 'check-list' }, items.map((it) => h('label', { class: 'checkbox' },
      it.box,
      h('span', { class: 'check-label' }, h('span', { class: 'ellipsis' }, it.label), it.sub ? h('span', { class: 'muted mono ellipsis check-sub' }, it.sub) : null),
    )));
  }

  function toggleAll(items) {
    return h('button', {
      class: 'btn-link', type: 'button',
      onclick: () => { const all = items.every((it) => it.box.checked); for (const it of items) it.box.checked = !all; },
    }, 'Tout cocher / décocher');
  }

  function shellLabel(shellId) {
    if (!shellId || shellId === 'default') {
      const def = State.info?.shells.find((s) => s.id === State.settings?.defaultShell);
      return `Par défaut (${def?.label || 'shell système'})`;
    }
    return State.info?.shells.find((s) => s.id === shellId)?.label || shellId;
  }

  const importSummary = (res, verb) => {
    const parts = [`${res.created} action(s) ${verb}`];
    if (res.replaced) parts.push(`${res.replaced} remplacée(s)`);
    if (res.skipped) parts.push(`${res.skipped} ignorée(s) (nom déjà utilisé)`);
    return `${parts.join(', ')}.`;
  };

  /* =====================================================
     Consultation d'un script (lecture seule)
     ===================================================== */
  function openScriptView(project, action) {
    const shell = action.shell && action.shell !== 'default' ? action.shell : State.settings?.defaultShell;
    const lang = { bash: 'bash', powershell: 'powershell', system: State.info?.platform === 'win32' ? 'dos' : 'bash' }[shell];
    const code = h('code');
    // highlight.js échappe le texte source : son HTML peut être inséré tel quel.
    if (typeof hljs !== 'undefined' && lang && hljs.getLanguage(lang)) code.innerHTML = hljs.highlight(action.script, { language: lang, ignoreIllegals: true }).value;
    else code.textContent = action.script;

    const m = UI.modal({
      title: action.name,
      size: 'lg',
      body: h('div', null,
        action.description ? h('p', { class: 'muted', style: { marginTop: 0 } }, action.description) : null,
        h('div', { class: 'script-meta' },
          h('span', { class: 'badge badge-muted' }, iconEl('terminal'), shellLabel(action.shell)),
          action.updatedAt ? h('span', { class: 'muted' }, `Modifiée ${formatRelative(action.updatedAt)}`) : null,
        ),
        h('pre', { class: 'code-view' }, code),
      ),
      footer: [
        h('button', { class: 'btn', type: 'button', onclick: () => m.close() }, 'Fermer'),
        h('button', {
          class: 'btn btn-accent', type: 'button', html: `${icon('pencil')}<span>Modifier</span>`,
          onclick: () => { m.close(); openActionModal(project, action); },
        }),
      ],
    });
  }

  /* =====================================================
     Export / import d'actions (fichier .gitpilot.json)
     ===================================================== */
  function openExportModal(project) {
    const items = project.actions.map((a) => ({ id: a.id, box: check(true), label: a.name, sub: shellLabel(a.shell) }));
    const errorBox = h('div');
    const submitBtn = h('button', { class: 'btn btn-accent', type: 'submit', form: 'export-form', html: `${icon('download')}<span>Exporter</span>` });
    const form = h('form', { id: 'export-form', novalidate: true },
      errorBox,
      h('div', { class: 'field' },
        h('div', { class: 'label-row' }, h('label', null, 'Actions à exporter'), toggleAll(items)),
        checkList(items),
      ),
      h('div', { class: 'hint muted', style: { fontSize: '13px' } },
        'Les actions sont enregistrées dans un fichier .gitpilot.json (nom, description, shell et script). Sur l’autre ordinateur, ouvrez un projet puis « Importer ».'),
    );
    const m = UI.modal({
      title: `Exporter des actions de « ${project.name} »`,
      body: form,
      footer: [h('button', { class: 'btn', type: 'button', onclick: () => m.tryClose() }, 'Annuler'), submitBtn],
    });
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      clear(errorBox);
      const ids = items.filter((it) => it.box.checked).map((it) => it.id);
      if (!ids.length) { errorBox.append(UI.alert('danger', 'Sélectionnez au moins une action à exporter.')); return; }
      try {
        const res = await window.gitpilot.actions.export(project.id, ids);
        if (!res) return; // enregistrement annulé
        m.close();
        UI.toast(`${res.count} action(s) exportée(s) dans ${res.file.split(/[\\/]/).pop()}.`, 'success');
      } catch (err) {
        errorBox.append(UI.alert('danger', err.message));
      }
    });
  }

  async function importActions(project) {
    let data;
    try {
      data = await window.gitpilot.actions.readImport();
    } catch (err) {
      UI.toast(err.message, 'danger', { timeout: 10000 });
      return;
    }
    if (!data) return; // ouverture annulée

    const existing = new Set(project.actions.map((a) => a.name.trim().toLowerCase()));
    const items = data.actions.map((a, i) => ({
      index: i, box: check(true), label: a.name,
      sub: `${shellLabel(a.shell)}${existing.has(a.name.trim().toLowerCase()) ? ' · nom déjà utilisé dans ce projet' : ''}`,
    }));
    const replaceCheck = check(false);
    const errorBox = h('div');
    const submitBtn = h('button', { class: 'btn btn-accent', type: 'submit', form: 'import-form', html: `${icon('upload')}<span>Importer</span>` });
    const form = h('form', { id: 'import-form', novalidate: true },
      errorBox,
      h('p', { style: { marginTop: 0 } }, 'Fichier ', h('strong', null, data.file), data.source ? ` (exporté depuis « ${data.source} »)` : ''),
      UI.alert('warning', 'Les scripts importés seront exécutés dans le dossier de ce projet. Consultez-les (clic sur l’action) avant de les lancer.'),
      h('div', { class: 'field', style: { marginTop: '14px' } },
        h('div', { class: 'label-row' }, h('label', null, 'Actions à importer'), toggleAll(items)),
        checkList(items),
      ),
      h('div', { class: 'field', style: { marginBottom: 0 } }, h('label', { class: 'checkbox' }, replaceCheck,
        h('span', null, 'Remplacer les actions portant le même nom',
          h('div', { class: 'hint', style: { margin: 0 } }, 'Sinon, une action dont le nom existe déjà dans ce projet est ignorée.')))),
    );
    const m = UI.modal({
      title: `Importer des actions dans « ${project.name} »`,
      body: form,
      footer: [h('button', { class: 'btn', type: 'button', onclick: () => m.tryClose() }, 'Annuler'), submitBtn],
    });
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      clear(errorBox);
      const chosen = items.filter((it) => it.box.checked).map((it) => data.actions[it.index]);
      if (!chosen.length) { errorBox.append(UI.alert('danger', 'Sélectionnez au moins une action à importer.')); return; }
      m.busy = true;
      UI.setLoading(submitBtn, true, 'Import…');
      try {
        const res = await window.gitpilot.actions.import(project.id, chosen, { replace: replaceCheck.checked });
        await State.loadProjects();
        m.busy = false;
        m.close();
        UI.toast(importSummary(res, 'importée(s)'), res.skipped && !res.created && !res.replaced ? 'warning' : 'success');
      } catch (err) {
        m.busy = false;
        UI.setLoading(submitBtn, false);
        errorBox.append(UI.alert('danger', err.message));
      }
    });
  }

  /* =====================================================
     Modale de copie d'actions vers d'autres projets
     ===================================================== */
  function openCopyModal(project) {
    const targets = State.projects
      .filter((p) => p.id !== project.id)
      .sort((a, b) => a.name.localeCompare(b.name, 'fr', { sensitivity: 'base' }));

    const actionChecks = project.actions.map((a) => ({ id: a.id, box: check(true), label: a.name }));
    const targetChecks = targets.map((p) => ({ id: p.id, box: check(false), label: p.name }));
    const replaceCheck = check(false);

    const errorBox = h('div');
    const submitBtn = h('button', { class: 'btn btn-accent', type: 'submit', form: 'copy-form' }, 'Copier');
    const form = h('form', { id: 'copy-form', novalidate: true },
      errorBox,
      h('div', { class: 'field' },
        h('div', { class: 'label-row' }, h('label', null, 'Actions à copier'), toggleAll(actionChecks)),
        checkList(actionChecks),
      ),
      h('div', { class: 'field' },
        h('div', { class: 'label-row' }, h('label', null, 'Projets de destination'), toggleAll(targetChecks)),
        checkList(targetChecks),
      ),
      h('div', { class: 'field', style: { marginBottom: 0 } }, h('label', { class: 'checkbox' }, replaceCheck,
        h('span', null, 'Remplacer les actions portant le même nom',
          h('div', { class: 'hint', style: { margin: 0 } }, 'Sinon, une action dont le nom existe déjà dans le projet de destination est ignorée.')))),
    );

    const m = UI.modal({
      title: `Copier des actions de « ${project.name} »`,
      body: form,
      footer: [h('button', { class: 'btn', type: 'button', onclick: () => m.tryClose() }, 'Annuler'), submitBtn],
    });

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      clear(errorBox);
      const actionIds = actionChecks.filter((it) => it.box.checked).map((it) => it.id);
      const targetIds = targetChecks.filter((it) => it.box.checked).map((it) => it.id);
      if (!actionIds.length) { errorBox.append(UI.alert('danger', 'Sélectionnez au moins une action à copier.')); return; }
      if (!targetIds.length) { errorBox.append(UI.alert('danger', 'Sélectionnez au moins un projet de destination.')); return; }
      m.busy = true;
      UI.setLoading(submitBtn, true, 'Copie…');
      try {
        const res = await window.gitpilot.actions.copy(project.id, actionIds, targetIds, { replace: replaceCheck.checked });
        await State.loadProjects();
        m.busy = false;
        m.close();
        UI.toast(importSummary(res, 'copiée(s)'), res.skipped && !res.created && !res.replaced ? 'warning' : 'success');
      } catch (err) {
        m.busy = false;
        UI.setLoading(submitBtn, false);
        errorBox.append(UI.alert('danger', err.message));
      }
    });
  }

  return { mount, openActionModal };
})();
