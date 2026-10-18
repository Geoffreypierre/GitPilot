'use strict';

const HomeView = (() => {
  const summaryCache = new Map(); // projectId -> { data } | { error }

  function mount(root) {
    const cleanups = [];
    const loading = new Map(); // un seul chargement du résumé Git par projet et par affichage
    let filter = prefs.get('home.filter', '');

    const searchInput = h('input', {
      class: 'input', type: 'search', placeholder: 'Filtrer les projets par nom ou chemin', value: filter,
      oninput: () => { filter = searchInput.value; prefs.set('home.filter', filter); renderCards(); },
    });
    const grid = h('div', { class: 'cards' });
    const countLabel = h('span', { class: 'muted' });
    const toolbar = h('div', { class: 'toolbar' },
      h('div', { class: 'search-box', style: { maxWidth: '420px' } }, iconEl('search'), searchInput),
      countLabel,
    );
    const listArea = h('div');
    const body = h('div');

    root.append(h('div', { class: 'page' },
      h('div', { class: 'page-header' },
        h('div', null,
          h('h1', { class: 'page-title' }, 'Projets'),
          h('p', { class: 'page-subtitle' }, 'Vos dépôts Git locaux, réunis au même endroit'),
        ),
        h('div', { class: 'page-actions' },
          h('button', { class: 'btn btn-accent', onclick: () => openAddProjectModal(), html: `${icon('plus')}<span>Ajouter un projet</span>` }),
        ),
      ),
      body,
    ));

    function renderCards() {
      const projects = State.projects;
      if (!projects.length) {
        clear(body);
        body.append(h('div', { class: 'empty-state' },
          h('div', { class: 'empty-icon', html: icon('repo') }),
          h('h3', null, 'Aucun projet pour le moment'),
          h('p', null, "Déclarez un dépôt Git local en renseignant son chemin. GitPilot ne parcourt jamais votre disque : seuls les dépôts que vous ajoutez sont gérés."),
          h('button', { class: 'btn btn-accent', onclick: () => openAddProjectModal(), html: `${icon('plus')}<span>Ajouter un projet</span>` }),
        ));
        return;
      }

      const q = filter.trim().toLowerCase();
      const visible = projects
        .filter((p) => !q || p.name.toLowerCase().includes(q) || p.path.toLowerCase().includes(q))
        .sort((a, b) => a.name.localeCompare(b.name, 'fr', { sensitivity: 'base' }));

      if (toolbar.parentNode !== body) {
        clear(body);
        body.append(toolbar, listArea);
      }
      countLabel.textContent = `${visible.length} projet${visible.length > 1 ? 's' : ''}${q ? ` sur ${projects.length}` : ''}`;

      clear(listArea);
      clear(grid);
      if (!visible.length) {
        listArea.append(h('div', { class: 'empty-inline' }, `Aucun projet ne correspond à « ${filter} ».`));
        return;
      }
      for (const project of visible) grid.append(card(project));
      listArea.append(grid);
    }

    function card(project) {
      const branchLine = h('div', { class: 'card-branch' });
      const stats = h('div', { class: 'card-foot' });
      const menuBtn = h('button', {
        class: 'btn btn-sm btn-icon btn-tertiary menu-btn', title: 'Options', 'aria-label': 'Options', html: icon('ellipsis'),
        onclick: (e) => {
          e.stopPropagation();
          UI.dropdown(menuBtn, [
            { label: 'Ouvrir le projet', icon: 'chevronRight', onClick: () => App.navigate(`/project/${project.id}`) },
            { label: 'Ouvrir le dossier', icon: 'folder', onClick: () => openFolder(project) },
            'sep',
            { label: 'Retirer du dashboard', icon: 'trash', danger: true, onClick: () => removeProject(project) },
          ]);
        },
      });

      const el = h('div', {
        class: 'card', tabindex: '0', role: 'link', 'aria-label': `Ouvrir ${project.name}`,
        onclick: () => App.navigate(`/project/${project.id}`),
        onkeydown: (e) => { if (e.key === 'Enter') App.navigate(`/project/${project.id}`); },
      },
        h('div', { class: 'card-head' },
          h('div', { class: 'project-avatar', style: { background: colorFor(project.name) } }, initials(project.name)),
          h('div', { style: { minWidth: 0, flex: 1 } },
            h('div', { class: 'card-title ellipsis' }, project.name),
            h('div', { class: 'card-path ellipsis', title: project.path }, h('bdi', null, project.path)),
          ),
          menuBtn,
        ),
        branchLine,
        stats,
      );

      const fill = (entry) => {
        clear(branchLine);
        clear(stats);
        const running = State.runsFor(project.id).filter((r) => r.status === 'running').length;
        const actionsStat = h('span', { class: 'stat', title: 'Actions personnalisées' }, iconEl('terminal'), `${project.actions.length} action${project.actions.length > 1 ? 's' : ''}`);

        if (!entry) {
          branchLine.append(iconEl('branch', 'branch-icon'), h('span', { class: 'skeleton', style: { width: '140px' } }));
          stats.append(actionsStat, h('span', { class: 'skeleton', style: { width: '120px' } }));
        } else if (entry.error) {
          branchLine.append(h('span', { class: 'badge badge-danger' }, iconEl('warning'), 'Dépôt inaccessible'));
          branchLine.append(h('span', { class: 'muted ellipsis', title: entry.error }, entry.error));
          stats.append(actionsStat);
        } else {
          const d = entry.data;
          branchLine.append(
            iconEl('branch', 'branch-icon'),
            h('span', { class: 'name ellipsis', title: d.current.name }, d.current.name),
          );
          stats.append(
            actionsStat,
            h('span', { class: 'stat', title: 'Branches locales / distantes' }, iconEl('branch'), `${d.localCount} locale${d.localCount > 1 ? 's' : ''} · ${d.remoteCount} distante${d.remoteCount > 1 ? 's' : ''}`),
            d.lastActivity ? h('span', { class: 'stat', title: `Dernier commit : ${formatDate(d.lastActivity)}`, style: { marginLeft: 'auto' } }, iconEl('clock'), formatRelative(d.lastActivity)) : null,
          );
        }
        if (running) {
          branchLine.append(h('span', { class: 'badge badge-info', style: { marginLeft: 'auto' } }, h('span', { class: 'spinner', style: { width: '10px', height: '10px', borderWidth: '2px' } }), `${running} en cours`));
        }
      };

      fill(summaryCache.get(project.id));
      if (!loading.has(project.id)) loading.set(project.id, loadSummary(project));
      loading.get(project.id).then(() => el.isConnected && fill(summaryCache.get(project.id)));
      el.refreshStatus = () => fill(summaryCache.get(project.id));
      el.dataset.projectId = project.id;
      return el;
    }

    async function loadSummary(project) {
      try {
        const data = await window.gitpilot.projects.summary(project.id);
        summaryCache.set(project.id, { data });
      } catch (err) {
        summaryCache.set(project.id, { error: err.message });
      }
      return summaryCache.get(project.id);
    }

    renderCards();
    cleanups.push(State.on('projects', renderCards));
    cleanups.push(State.on('run-status', (run) => {
      grid.querySelector(`[data-project-id="${CSS.escape(run.projectId)}"]`)?.refreshStatus?.();
    }));

    return () => cleanups.forEach((fn) => fn());
  }

  async function openFolder(project) {
    try {
      await window.gitpilot.projects.openFolder(project.id);
    } catch (err) {
      UI.toast(err.message, 'danger');
    }
  }

  async function removeProject(project) {
    const running = State.runsFor(project.id).some((r) => r.status === 'running');
    const ok = await UI.confirm({
      title: 'Retirer le projet',
      message: h('div', null,
        h('p', { style: { marginTop: 0 } }, 'Retirer ', h('strong', null, project.name), ' du dashboard ?'),
        h('p', { class: 'muted', style: { marginBottom: 0 } },
          `Les fichiers du dépôt (${project.path}) ne seront pas supprimés. Les ${project.actions.length} action(s) associée(s) seront retirées.`,
          running ? ' Les actions en cours seront arrêtées.' : ''),
      ),
      confirmLabel: 'Retirer',
      danger: true,
    });
    if (!ok) return;
    try {
      await window.gitpilot.projects.remove(project.id);
      summaryCache.delete(project.id);
      State.removeProject(project.id);
      UI.toast(`« ${project.name} » a été retiré du dashboard.`, 'success');
      if (location.hash.includes(project.id)) App.navigate('/');
    } catch (err) {
      UI.toast(err.message, 'danger');
    }
  }

  function openAddProjectModal() {
    const pathInput = h('input', { class: 'input mono', placeholder: 'C:\\chemin\\vers\\mon-depot', autofocus: true, spellcheck: 'false' });
    const nameInput = h('input', { class: 'input', placeholder: 'Nom du dossier par défaut', maxlength: '100' });
    const errorBox = h('div');
    const browseBtn = h('button', {
      class: 'btn', type: 'button',
      onclick: async () => {
        try {
          const dir = await window.gitpilot.app.browse();
          if (dir) { pathInput.value = dir; syncName(); pathInput.focus(); }
        } catch (err) { UI.toast(err.message, 'danger'); }
      },
      html: `${icon('folder')}<span>Parcourir…</span>`,
    });

    const syncName = () => {
      const base = pathInput.value.trim().replace(/[\\/]+$/, '').split(/[\\/]/).pop();
      nameInput.placeholder = base || 'Nom du dossier par défaut';
    };
    pathInput.addEventListener('input', syncName);

    const submitBtn = h('button', { class: 'btn btn-accent', type: 'submit', form: 'add-project-form' }, 'Ajouter le projet');
    const form = h('form', { id: 'add-project-form', novalidate: true },
      errorBox,
      h('div', { class: 'field' },
        h('label', { for: 'pp' }, 'Chemin local du dépôt'),
        h('div', { class: 'input-group' }, pathInput, browseBtn),
        h('div', { class: 'hint' }, 'Chemin absolu vers un dossier contenant un dépôt Git. Un sous-dossier sera ramené à la racine du dépôt.'),
      ),
      h('div', { class: 'field', style: { marginBottom: 0 } },
        h('label', null, "Nom d'affichage ", h('span', { class: 'optional' }, '(facultatif)')),
        nameInput,
      ),
    );
    pathInput.id = 'pp';

    const m = UI.modal({
      title: 'Ajouter un projet',
      body: form,
      footer: [
        h('div', { class: 'left' }, iconEl('info'), 'Un git fetch sera lancé pour récupérer les branches distantes.'),
        h('button', { class: 'btn', type: 'button', onclick: () => m.tryClose() }, 'Annuler'),
        submitBtn,
      ],
    });

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      clear(errorBox);
      if (!pathInput.value.trim()) {
        errorBox.append(UI.alert('danger', 'Veuillez renseigner le chemin du dépôt.'));
        pathInput.focus();
        return;
      }
      m.busy = true;
      UI.setLoading(submitBtn, true, 'Vérification et git fetch…');
      browseBtn.disabled = true;
      try {
        const res = await window.gitpilot.projects.add({ path: pathInput.value, name: nameInput.value });
        State.upsertProject(res.project);
        m.busy = false;
        m.close();
        UI.toast(`Projet « ${res.project.name} » ajouté.`, 'success');
        if (res.normalizedFrom) UI.toast(`Chemin ramené à la racine du dépôt : ${res.project.path}`, 'info');
        if (!res.fetch.ok) UI.toast(`Le dépôt a été ajouté, mais git fetch a échoué : ${res.fetch.error}`, 'warning');
      } catch (err) {
        m.busy = false;
        UI.setLoading(submitBtn, false);
        browseBtn.disabled = false;
        errorBox.append(UI.alert('danger', err.message, 'Impossible d’ajouter ce projet'));
        pathInput.focus();
      }
    });
  }

  return { mount, openAddProjectModal, removeProject, openFolder };
})();
