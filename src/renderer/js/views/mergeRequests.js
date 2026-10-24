'use strict';

/**
 * Merge requests (GitLab) / pull requests (GitHub) : onglet de liste dans la page projet,
 * création, et page de détail (vue d'ensemble, commits, changements) avec modification
 * de la branche cible, du titre, du statut brouillon, fermeture et fusion.
 */
const MergeRequestsView = (() => {
  const STATE_FILTERS = [['opened', 'Ouvertes'], ['merged', 'Fusionnées'], ['closed', 'Fermées'], ['all', 'Toutes']];
  const STATE_BADGE = {
    opened: ['Ouverte', 'badge-success'],
    merged: ['Fusionnée', 'badge-info'],
    closed: ['Fermée', 'badge-danger'],
  };

  const kindOf = (provider) => (provider === 'github' ? 'pull request' : 'merge request');
  const capital = (s) => s.charAt(0).toUpperCase() + s.slice(1);
  const refOf = (provider, n) => (provider === 'github' ? `#${n}` : `!${n}`);

  function stateBadge(mr) {
    const [label, cls] = STATE_BADGE[mr.state] || STATE_BADGE.opened;
    return h('span', { class: `badge ${cls}` }, label);
  }

  /* =====================================================
     Onglet « Merge requests » de la page projet
     ===================================================== */
  function mountTab(panel, project, { onProvider } = {}) {
    let destroyed = false;
    let state = prefs.get(`mr.state.${project.id}`, 'opened');
    let page = 1;
    let items = [];
    let provider = null;
    let query = '';

    const segButtons = STATE_FILTERS.map(([value, label]) => h('button', {
      type: 'button', dataset: { state: value },
      onclick: () => { state = value; prefs.set(`mr.state.${project.id}`, value); reload(); },
    }, label));
    const searchInput = h('input', {
      class: 'input', type: 'search', placeholder: 'Filtrer par titre, branche ou auteur…',
      oninput: () => { query = searchInput.value.trim().toLowerCase(); renderList(); },
    });
    const newBtn = h('button', {
      class: 'btn btn-accent', type: 'button', html: `${icon('pullRequest')}<span>Nouvelle merge request</span>`,
      onclick: () => openCreateModal(project, null, { onCreated: () => reload() }),
    });
    const refreshBtn = h('button', { class: 'btn', type: 'button', title: 'Recharger la liste', html: `${icon('refresh')}<span>Actualiser</span>`, onclick: () => reload() });
    const listSlot = h('div');
    const footer = h('div', { class: 'list-footer' });

    panel.append(
      h('div', { class: 'toolbar' },
        h('div', { class: 'search-box' }, iconEl('search'), searchInput),
        h('div', { class: 'segmented', role: 'group', 'aria-label': 'État' }, segButtons),
        refreshBtn,
        newBtn,
      ),
      listSlot,
      footer,
    );

    function row(mr) {
      return h('a', { class: 'list-item mr-row', href: `#/project/${project.id}/mr/${mr.number}` },
        h('span', { class: `mr-state-icon mr-${mr.state}`, html: icon('pullRequest') }),
        h('div', { class: 'mr-main' },
          h('div', { class: 'mr-title' },
            mr.draft ? h('span', { class: 'badge badge-muted' }, 'Brouillon') : null,
            h('span', { class: 'ellipsis' }, mr.title)),
          h('div', { class: 'mr-meta' },
            h('span', null, refOf(provider, mr.number)),
            h('span', { class: 'sep-dot' }),
            h('span', null, `ouverte ${formatRelative(mr.createdAt)} par `, h('strong', null, mr.author)),
            h('span', { class: 'sep-dot' }),
            h('span', { class: 'mr-branches-inline mono' }, mr.source, ' → ', mr.target)),
        ),
        h('div', { class: 'mr-side' },
          mr.state !== 'opened' ? stateBadge(mr) : null,
          mr.comments ? h('span', { class: 'stat', title: 'Commentaires' }, iconEl('comment'), String(mr.comments)) : null,
          h('span', { class: 'muted', title: formatDate(mr.updatedAt) }, `mise à jour ${formatRelative(mr.updatedAt)}`)),
      );
    }

    function renderList() {
      for (const b of segButtons) b.classList.toggle('active', b.dataset.state === state);
      clear(listSlot);
      const shown = query
        ? items.filter((mr) => [mr.title, mr.source, mr.target, mr.author].some((v) => String(v || '').toLowerCase().includes(query)))
        : items;
      if (!shown.length) {
        listSlot.append(h('div', { class: 'list' }, h('div', { class: 'empty-inline' },
          query ? `Aucune ${kindOf(provider)} ne correspond à « ${searchInput.value.trim()} ».` : `Aucune ${kindOf(provider)} ${STATE_FILTERS.find(([v]) => v === state)[1].toLowerCase()}.`)));
        return;
      }
      listSlot.append(h('div', { class: 'list' }, shown.map(row)));
    }

    function renderStatus(res) {
      clear(listSlot);
      clear(footer);
      if (res.status === 'none') {
        listSlot.append(h('div', { class: 'empty-state' },
          h('div', { class: 'empty-icon', html: icon('pullRequest') }),
          h('h3', null, 'Aucun dépôt distant GitHub ou GitLab'),
          h('p', null, 'Les merge requests sont disponibles pour les projets dont le remote (origin) est hébergé sur GitHub ou GitLab.')));
        newBtn.disabled = true;
        return;
      }
      if (res.status === 'disconnected') {
        listSlot.append(h('div', { class: 'empty-state' },
          h('div', { class: 'empty-icon', html: icon('lock') }),
          h('h3', null, `Connectez votre compte ${res.host}`),
          h('p', null, `GitPilot a besoin de votre compte pour lire et gérer les ${kindOf(res.provider)}s de ce projet.`),
          h('button', {
            class: 'btn btn-accent', type: 'button',
            onclick: async () => { if (await Accounts.openConnectModal(res.host)) reload(); },
          }, `Connecter ${res.host}`)));
        return;
      }
      listSlot.append(UI.alert('danger', res.error, `Impossible de lire les ${kindOf(res.provider)}s`));
    }

    async function load() {
      clear(footer);
      footer.append(h('span', { class: 'inline-spinner' }, h('span', { class: 'spinner' }), 'Chargement…'));
      let res;
      try {
        res = await window.gitpilot.mr.list(project.id, { state, page });
      } catch (err) {
        res = { status: 'error', error: err.message };
      }
      if (destroyed) return;
      provider = res.provider || provider;
      if (provider) {
        newBtn.lastChild.textContent = `Nouvelle ${kindOf(provider)}`;
        onProvider?.(provider);
      }
      if (res.status !== 'ok') { renderStatus(res); return; }
      newBtn.disabled = false;
      items = page === 1 ? res.items : [...items, ...res.items];
      renderList();
      clear(footer);
      if (items.length) footer.append(h('span', null, `${items.length} ${kindOf(provider)}${items.length > 1 ? 's' : ''}`));
      if (res.hasMore) {
        footer.append(h('button', {
          class: 'btn btn-sm', type: 'button', html: `${icon('chevronDown')}<span>Charger plus</span>`,
          onclick: () => { page += 1; load(); },
        }));
      }
    }

    function reload() {
      page = 1;
      items = [];
      for (const b of segButtons) b.classList.toggle('active', b.dataset.state === state);
      clear(listSlot);
      listSlot.append(h('div', { class: 'list' }, h('div', { class: 'loading-block' }, h('span', { class: 'spinner spinner-lg' }), 'Chargement…')));
      load();
    }

    const off = State.on('mr-changed', (detail) => { if (detail?.projectId === project.id) reload(); });
    reload();
    return { reload, destroy: () => { destroyed = true; off(); } };
  }

  /* =====================================================
     Création
     ===================================================== */

  /** Sans branche source : on la choisit d'abord parmi les branches du dépôt. */
  async function chooseSource(project) {
    let data;
    try {
      data = await window.gitpilot.projects.branches(project.id, {});
    } catch (err) {
      UI.toast(err.message, 'danger');
      return null;
    }
    const candidates = data.branches.filter((b) => !b.isDefault);
    if (!candidates.length) {
      UI.toast('Aucune branche disponible : créez une branche de travail.', 'warning');
      return null;
    }
    return new Promise((resolve) => {
      let chosen = null;
      const select = h('select', { class: 'select' }, candidates.map((b) => h('option', { value: b.ref }, `${b.name}${b.type === 'local' ? ' (locale)' : ''}`)));
      const current = candidates.find((b) => b.current);
      if (current) select.value = current.ref;
      const next = h('button', { class: 'btn btn-accent', type: 'button', onclick: () => { chosen = select.value; m.close(); } }, 'Continuer');
      const m = UI.modal({
        title: 'Branche source',
        body: h('div', { class: 'field', style: { marginBottom: 0 } }, h('label', null, 'Branche à fusionner'), select),
        footer: [h('button', { class: 'btn', type: 'button', onclick: () => m.close() }, 'Annuler'), next],
        onClose: () => resolve(chosen),
      });
    });
  }

  async function openCreateModal(project, ref = null, { onCreated } = {}) {
    const sourceRef = ref || await chooseSource(project);
    if (!sourceRef) return;
    let info;
    try {
      info = await window.gitpilot.hosting.mergeRequestInfo(project.id, sourceRef);
    } catch (err) {
      UI.toast(err.message, 'danger');
      return;
    }
    const label = kindOf(info.provider);
    if (!info.published) {
      UI.toast(`La branche « ${info.sourceName} » n'existe pas encore sur ${info.host} : publiez-la (git push) avant de créer une ${label}.`, 'warning', { timeout: 10000 });
      return;
    }
    if (!info.targets.length) {
      UI.toast(`Aucune branche cible disponible sur ${info.host}.`, 'warning');
      return;
    }
    if (!info.connected && !(await Accounts.openConnectModal(info.host))) return;

    const targetSelect = h('select', { class: 'select' }, info.targets.map((t) => h('option', { value: t }, t)));
    targetSelect.value = info.defaultTarget || info.targets[0];
    const titleInput = h('input', { class: 'input', maxlength: '255', value: info.title });
    const descInput = h('textarea', { class: 'textarea', rows: '6', style: { minHeight: '120px', fontFamily: 'var(--font)' }, placeholder: 'Description (Markdown)' });
    const draftCheck = h('input', { type: 'checkbox' });
    const removeCheck = h('input', { type: 'checkbox' });
    const errorBox = h('div');
    const submitBtn = h('button', { class: 'btn btn-accent', type: 'submit', form: 'mr-form', html: `${icon('pullRequest')}<span>Créer la ${label}</span>` });
    const form = h('form', { id: 'mr-form', novalidate: true },
      errorBox,
      h('div', { class: 'mr-branches' }, h('span', { class: 'mr-branch mono' }, info.sourceName), iconEl('chevronRight'), targetSelect),
      h('div', { class: 'field' }, h('label', null, 'Titre'), titleInput),
      h('div', { class: 'field' }, h('label', null, 'Description ', h('span', { class: 'optional' }, '(facultative)')), descInput),
      h('div', { class: 'field', style: { marginBottom: info.provider === 'gitlab' ? '10px' : 0 } }, h('label', { class: 'checkbox' }, draftCheck,
        h('span', null, 'Brouillon (draft)', h('div', { class: 'hint', style: { margin: 0 } }, 'Ne peut pas être fusionnée tant qu’elle est en brouillon.')))),
      info.provider === 'gitlab' ? h('div', { class: 'field', style: { marginBottom: 0 } }, h('label', { class: 'checkbox' }, removeCheck,
        h('span', null, 'Supprimer la branche source après la fusion'))) : null,
    );
    const m = UI.modal({
      title: `Nouvelle ${label} sur ${info.host}`,
      size: 'lg',
      body: form,
      footer: [h('button', { class: 'btn', type: 'button', onclick: () => m.tryClose() }, 'Annuler'), submitBtn],
    });
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      clear(errorBox);
      if (!titleInput.value.trim()) { errorBox.append(UI.alert('danger', 'Le titre est obligatoire.')); titleInput.focus(); return; }
      m.busy = true;
      UI.setLoading(submitBtn, true, 'Création…');
      try {
        const res = await window.gitpilot.hosting.createMergeRequest(project.id, {
          ref: sourceRef, target: targetSelect.value, title: titleInput.value, description: descInput.value,
          draft: draftCheck.checked, removeSource: removeCheck.checked,
        });
        m.busy = false;
        m.close();
        State.emit('mr-changed', { projectId: project.id });
        onCreated?.(res);
        UI.toast(h('span', null, `${capital(label)} ${refOf(info.provider, res.number)} créée. `,
          h('a', { href: `#/project/${project.id}/mr/${res.number}` }, 'Afficher')), 'success', { timeout: 12000 });
      } catch (err) {
        m.busy = false;
        UI.setLoading(submitBtn, false);
        errorBox.append(UI.alert('danger', err.message));
      }
    });
  }

  /* =====================================================
     Page de détail
     ===================================================== */
  function mountDetail(root, projectId, number, params = {}) {
    const project = State.getProject(projectId);
    if (!project) return CommitsView.notFound(root);
    let destroyed = false;
    let tab = ['overview', 'commits', 'changes'].includes(params.tab) ? params.tab : 'overview';
    let mr = null;
    let threadState = null;
    let commits = null;
    let changes = null;

    const body = h('div', null, h('div', { class: 'loading-block' }, h('span', { class: 'spinner spinner-lg' }), 'Chargement…'));
    root.append(h('div', { class: 'page' }, DiffView.backLink(`#/project/${projectId}?tab=mr`, 'Retour'), body));

    const label = () => kindOf(mr?.provider);
    const actions = () => ({
      canWrite: threadState?.status === 'ok',
      reply: (thread, text) => window.gitpilot.mr.replyThread(projectId, number, thread.id, text),
      resolve: mr?.canResolve ? (thread, resolved) => window.gitpilot.mr.resolveThread(projectId, number, thread.id, resolved) : null,
      refresh: reloadThreads,
    });

    /** Relit les threads sur le serveur : l'affichage reflète ce qui est réellement enregistré. */
    async function reloadThreads() {
      try {
        threadState = { status: 'ok', threads: await window.gitpilot.mr.threads(projectId, number) };
      } catch (err) {
        threadState = { status: 'error', error: err.message };
      }
      if (!destroyed) render();
    }

    async function load({ keepData = false } = {}) {
      const [mrRes, threadsRes] = await Promise.allSettled([
        window.gitpilot.mr.get(projectId, number),
        window.gitpilot.mr.threads(projectId, number),
      ]);
      if (destroyed) return;
      if (mrRes.status === 'rejected') {
        clear(body);
        body.append(UI.alert('danger', mrRes.reason.message, `Impossible de lire cette merge request`));
        return;
      }
      mr = mrRes.value;
      // Pas d'hôte dans l'état des threads : le bandeau d'identité est affiché dans l'en-tête.
      threadState = threadsRes.status === 'fulfilled'
        ? { status: 'ok', threads: threadsRes.value }
        : { status: 'error', error: threadsRes.reason.message };
      if (!keepData) { commits = null; changes = null; }
      render();
    }

    async function update(changesToApply, successMessage) {
      try {
        await window.gitpilot.mr.update(projectId, number, changesToApply);
        UI.toast(successMessage, 'success');
        State.emit('mr-changed', { projectId });
        await load({ keepData: !('target' in changesToApply) });
      } catch (err) {
        UI.toast(err.message, 'danger', { timeout: 12000 });
      }
    }

    /* ----- Fenêtres d'édition ----- */
    function openEdit() {
      const titleInput = h('input', { class: 'input', maxlength: '255', value: mr.title.replace(/^\s*(\[draft\]|\(draft\)|draft:|draft\s+-\s+)\s*/i, '') });
      const descInput = h('textarea', { class: 'textarea', rows: '10', style: { fontFamily: 'var(--font)' }, value: mr.description });
      const saveBtn = h('button', { class: 'btn btn-accent', type: 'submit', form: 'mr-edit' }, 'Enregistrer');
      const form = h('form', { id: 'mr-edit', novalidate: true },
        h('div', { class: 'field' }, h('label', null, 'Titre'), titleInput),
        h('div', { class: 'field', style: { marginBottom: 0 } }, h('label', null, 'Description (Markdown)'), descInput));
      const m = UI.modal({
        title: `Modifier la ${label()}`, size: 'lg', body: form,
        footer: [h('button', { class: 'btn', type: 'button', onclick: () => m.tryClose() }, 'Annuler'), saveBtn],
      });
      form.addEventListener('submit', async (e) => {
        e.preventDefault();
        if (!titleInput.value.trim()) { titleInput.focus(); return; }
        m.close();
        await update({ title: titleInput.value, description: descInput.value }, 'Modifications enregistrées.');
      });
    }

    async function openTarget() {
      let targets = [];
      try { targets = (await window.gitpilot.mr.targets(projectId)).filter((t) => t !== mr.source); } catch (err) { UI.toast(err.message, 'danger'); return; }
      if (!targets.includes(mr.target)) targets.unshift(mr.target);
      const select = h('select', { class: 'select' }, targets.map((t) => h('option', { value: t }, t)));
      select.value = mr.target;
      const saveBtn = h('button', { class: 'btn btn-accent', type: 'button' }, 'Changer la branche cible');
      const m = UI.modal({
        title: 'Branche cible',
        body: h('div', null,
          h('div', { class: 'mr-branches' }, h('span', { class: 'mr-branch mono' }, mr.source), iconEl('chevronRight'), select),
          h('div', { class: 'hint muted', style: { fontSize: '13px' } },
            'Les changements et l’état de fusion sont recalculés par le serveur. Liste issue du dernier fetch : actualisez le projet si une branche manque.')),
        footer: [h('button', { class: 'btn', type: 'button', onclick: () => m.close() }, 'Annuler'), saveBtn],
      });
      saveBtn.addEventListener('click', async () => {
        if (select.value === mr.target) { m.close(); return; }
        m.close();
        await update({ target: select.value }, `Branche cible : ${select.value}.`);
      });
    }

    function openMerge() {
      const squashCheck = h('input', { type: 'checkbox' });
      squashCheck.checked = mr.squash;
      const removeCheck = h('input', { type: 'checkbox' });
      removeCheck.checked = mr.removeSource;
      const canRemove = mr.sameRepo !== false;
      const mergeBtn = h('button', { class: 'btn btn-accent', type: 'button', disabled: !mr.merge.canMerge }, 'Fusionner');
      const m = UI.modal({
        title: `Fusionner ${refOf(mr.provider, mr.number)}`,
        body: h('div', null,
          h('div', { class: 'mr-branches' }, h('span', { class: 'mr-branch mono' }, mr.source), iconEl('chevronRight'), h('span', { class: 'mr-branch mono' }, mr.target)),
          mr.merge.canMerge ? null : UI.alert(mr.merge.tone === 'danger' ? 'danger' : 'warning', mr.merge.label, 'Fusion impossible pour le moment'),
          h('div', { class: 'field', style: { marginTop: '14px' } }, h('label', { class: 'checkbox' }, squashCheck,
            h('span', null, 'Regrouper les commits (squash)', h('div', { class: 'hint', style: { margin: 0 } }, 'Un seul commit est ajouté à la branche cible.')))),
          canRemove ? h('div', { class: 'field', style: { marginBottom: 0 } }, h('label', { class: 'checkbox' }, removeCheck,
            h('span', null, `Supprimer la branche source (${mr.source}) après la fusion`))) : null),
        footer: [h('button', { class: 'btn', type: 'button', onclick: () => m.tryClose() }, 'Annuler'), mergeBtn],
      });
      mergeBtn.addEventListener('click', async () => {
        m.busy = true;
        UI.setLoading(mergeBtn, true, 'Fusion…');
        try {
          await window.gitpilot.mr.merge(projectId, number, { squash: squashCheck.checked, removeSource: canRemove && removeCheck.checked });
          m.busy = false;
          m.close();
          UI.toast(`${capital(label())} fusionnée dans ${mr.target}.`, 'success');
          State.emit('mr-changed', { projectId });
          load();
        } catch (err) {
          m.busy = false;
          UI.setLoading(mergeBtn, false);
          UI.toast(err.message, 'danger', { timeout: 12000 });
        }
      });
    }

    async function toggleState() {
      if (mr.state === 'opened') {
        const ok = await UI.confirm({ title: `Fermer la ${label()}`, message: `Fermer ${refOf(mr.provider, mr.number)} sans la fusionner ? Elle pourra être rouverte.`, confirmLabel: 'Fermer', danger: true });
        if (ok) await update({ state: 'close' }, `${capital(label())} fermée.`);
      } else {
        await update({ state: 'reopen' }, `${capital(label())} rouverte.`);
      }
    }

    /* ----- Rendu ----- */
    function render() {
      clear(body);
      const open = mr.state === 'opened';
      const tabs = [
        ['overview', 'Vue d’ensemble', threadState?.status === 'ok' ? threadState.threads.length : null],
        ['commits', 'Commits', mr.commitCount ?? commits?.length ?? null],
        ['changes', 'Changements', mr.changeCount ?? changes?.files.length ?? null],
      ];
      const tabBar = h('div', { class: 'tabs', role: 'tablist' }, tabs.map(([value, text, count]) => h('button', {
        class: `tab ${tab === value ? 'active' : ''}`, role: 'tab', type: 'button', 'aria-selected': String(tab === value),
        onclick: () => { tab = value; history.replaceState(null, '', `#/project/${projectId}/mr/${number}?tab=${value}`); render(); },
      }, text, count != null ? h('span', { class: 'count-badge' }, String(count)) : null)));
      const panel = h('div');

      body.append(
        h('div', { class: 'page-header mr-header' },
          h('div', { style: { minWidth: 0 } },
            h('h1', { class: 'page-title' }, mr.draft ? h('span', { class: 'badge badge-muted mr-draft' }, 'Brouillon') : null, mr.title.replace(/^\s*draft:\s*/i, '')),
            h('div', { class: 'mr-meta mr-meta-lg' },
              stateBadge(mr),
              h('strong', null, refOf(mr.provider, mr.number)),
              h('span', null, `créée ${formatRelative(mr.createdAt)} par `, h('strong', null, mr.author)),
              h('span', { class: 'mr-branch mono' }, mr.source),
              iconEl('chevronRight'),
              h('span', { class: 'mr-branch mono' }, mr.target),
              open ? h('button', { class: 'btn btn-sm btn-tertiary', type: 'button', html: `${icon('pencil')}<span>Changer la cible</span>`, onclick: openTarget }) : null),
            Accounts.identityBar(mr.host, { onChange: () => load({ keepData: true }) }),
          ),
          h('div', { class: 'page-actions' },
            open ? h('button', { class: 'btn', type: 'button', html: `${icon('pencil')}<span>Modifier</span>`, onclick: openEdit }) : null,
            open ? h('button', {
              class: 'btn', type: 'button',
              onclick: () => update({ draft: !mr.draft }, mr.draft ? 'Marquée comme prête.' : 'Marquée comme brouillon.'),
            }, mr.draft ? 'Marquer comme prête' : 'Marquer comme brouillon') : null,
            mr.state !== 'merged' ? h('button', { class: `btn ${open ? 'btn-danger' : ''}`, type: 'button', onclick: toggleState }, open ? 'Fermer' : 'Rouvrir') : null,
            h('button', { class: 'btn', type: 'button', title: 'Ouvrir dans le navigateur', html: `${icon('external')}<span>Ouvrir</span>`, onclick: () => window.gitpilot.app.openUrl(mr.url) }),
          ),
        ),
        tabBar,
        panel,
      );
      renderPanel(panel);
    }

    function mergeBox() {
      if (mr.state === 'merged') {
        return h('div', { class: 'mr-status mr-status-info' }, iconEl('pullRequest'),
          h('div', null, h('strong', null, 'Fusionnée'), mr.mergedBy ? ` par ${mr.mergedBy}` : '', mr.mergedAt ? ` ${formatRelative(mr.mergedAt)}` : '', ` dans ${mr.target}.`));
      }
      if (mr.state === 'closed') {
        return h('div', { class: 'mr-status mr-status-danger' }, iconEl('xCircle'),
          h('div', null, h('strong', null, 'Fermée'), mr.closedAt ? ` ${formatRelative(mr.closedAt)}` : '', ' sans être fusionnée.'));
      }
      const tone = mr.merge.tone;
      return h('div', { class: `mr-status mr-status-${tone}` },
        iconEl(tone === 'success' ? 'checkCircle' : tone === 'danger' ? 'xCircle' : tone === 'info' ? 'clock' : 'warning'),
        h('div', { class: 'mr-status-text' }, mr.merge.label),
        h('button', { class: 'btn btn-accent', type: 'button', disabled: !mr.merge.canMerge, onclick: openMerge, html: `${icon('pullRequest')}<span>Fusionner</span>` }));
    }

    function renderPanel(panel) {
      if (tab === 'overview') {
        const all = threadState?.status === 'ok' ? threadState.threads : [];
        const general = all.map((t) => ({ thread: t, label: t.path ? `${t.path}${t.line ? `:${t.line}` : ''}${t.outdated ? ' (obsolète)' : ''}` : null }));
        panel.append(
          h('div', { class: 'commit-card mr-description' },
            mr.description ? Markdown.render(mr.description) : h('div', { class: 'muted' }, 'Aucune description.')),
          mergeBox(),
          h('section', { class: 'discussion' }, DiffView.discussion({
            state: threadState,
            general,
            actions: actions(),
            onCreate: (text) => window.gitpilot.mr.createThread(projectId, number, { body: text }),
          })),
        );
        return;
      }
      if (tab === 'commits') {
        if (!commits) {
          panel.append(h('div', { class: 'loading-block' }, h('span', { class: 'spinner spinner-lg' }), 'Chargement des commits…'));
          window.gitpilot.mr.commits(projectId, number).then((list) => {
            commits = list;
            if (!destroyed && tab === 'commits') render();
          }).catch((err) => { if (!destroyed) { clear(panel); panel.append(UI.alert('danger', err.message)); } });
          return;
        }
        if (!commits.length) { panel.append(h('div', { class: 'empty-inline' }, 'Aucun commit.')); return; }
        const list = h('div', { class: 'commit-days' });
        CommitsView.appendByDay(list, commits, (c) => {
          const rowEl = CommitsView.commitRow(projectId, c, null);
          rowEl.href = `#/project/${projectId}/commit/${c.sha}?mr=${number}`;
          return rowEl;
        });
        panel.append(list);
        DiffView.loadAvatars(list, projectId, null);
        return;
      }
      // Changements
      if (!changes) {
        panel.append(h('div', { class: 'loading-block' }, h('span', { class: 'spinner spinner-lg' }), 'Chargement des changements…'));
        window.gitpilot.mr.changes(projectId, number).then((diff) => {
          changes = diff;
          if (!destroyed && tab === 'changes') render();
        }).catch((err) => { if (!destroyed) { clear(panel); panel.append(UI.alert('danger', err.message)); } });
        return;
      }
      const canWrite = threadState?.status === 'ok';
      const { lineThreads } = canWrite
        ? DiffView.splitThreads(threadState.threads, changes.files, DiffView.lineKey, DiffView.threadLineKey)
        : { lineThreads: new Map() };
      panel.append(...DiffView.files(changes, {
        canComment: canWrite && mr.state === 'opened',
        keyFor: DiffView.lineKey,
        lineThreads,
        actions: actions(),
        createLineThread: (anchor, text) => window.gitpilot.mr.createThread(projectId, number, { body: text, anchor }),
      }, { emptyText: 'Aucun changement.' }));
    }

    load();
    return () => { destroyed = true; };
  }

  return { mountTab, openCreateModal, mountDetail };
})();
