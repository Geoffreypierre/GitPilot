'use strict';

const App = (() => {
  const view = document.getElementById('view');
  const breadcrumb = document.getElementById('breadcrumb');
  const runsBtn = document.getElementById('btn-runs');
  const runsBadge = document.getElementById('runs-badge');
  const settingsBtn = document.getElementById('btn-settings');
  let unmount = null;
  let currentRoute = { name: 'home' };

  /* ---------- Routage (hash) ---------- */
  function parseHash() {
    const raw = location.hash.replace(/^#/, '') || '/';
    const [pathPart, query = ''] = raw.split('?');
    const params = Object.fromEntries(new URLSearchParams(query));
    let m = pathPart.match(/^\/project\/([\w-]+)$/);
    if (m) return { name: 'project', id: m[1], params };
    m = pathPart.match(/^\/project\/([\w-]+)\/commits$/);
    if (m) return { name: 'commits', id: m[1], params };
    m = pathPart.match(/^\/project\/([\w-]+)\/commit\/([0-9a-f]{7,40})$/i);
    if (m) return { name: 'commit', id: m[1], sha: m[2], params };
    m = pathPart.match(/^\/project\/([\w-]+)\/mr\/(\d+)$/);
    if (m) return { name: 'mr', id: m[1], number: Number(m[2]), params };
    return { name: 'home', params };
  }

  function navigate(path) {
    if (location.hash === `#${path}`) route();
    else location.hash = path;
  }

  function route() {
    UI.closeDropdown();
    if (unmount) { unmount(); unmount = null; }
    clear(view);
    view.scrollTop = 0;
    currentRoute = parseHash();

    if (currentRoute.name === 'project') {
      unmount = ProjectView.mount(view, currentRoute.id, currentRoute.params);
    } else if (currentRoute.name === 'commits') {
      unmount = CommitsView.mountList(view, currentRoute.id, currentRoute.params);
    } else if (currentRoute.name === 'commit') {
      unmount = CommitsView.mountCommit(view, currentRoute.id, currentRoute.sha, currentRoute.params);
    } else if (currentRoute.name === 'mr') {
      unmount = MergeRequestsView.mountDetail(view, currentRoute.id, currentRoute.number, currentRoute.params);
    } else {
      unmount = HomeView.mount(view);
    }
    renderBreadcrumb();
  }

  function renderBreadcrumb() {
    clear(breadcrumb);
    if (currentRoute.name !== 'home') {
      const project = State.getProject(currentRoute.id);
      const sep = () => h('span', { class: 'crumb-sep', html: icon('chevronRight') });
      const ref = currentRoute.params.ref || '';
      const branchName = ref.replace(/^refs\/(heads|remotes)\//, '');
      const crumbs = [{ label: 'Dashboard', href: '#/' }, { label: project?.name || 'Projet introuvable', href: `#/project/${currentRoute.id}?tab=branches` }];
      if (currentRoute.name !== 'project' && ref) crumbs.push({ label: branchName, href: `#/project/${currentRoute.id}/commits?ref=${encodeURIComponent(ref)}` });
      if (currentRoute.name === 'commit' && currentRoute.params.mr) crumbs.push({ label: `!${currentRoute.params.mr}`, href: `#/project/${currentRoute.id}/mr/${currentRoute.params.mr}?tab=commits` });
      if (currentRoute.name === 'commit') crumbs.push({ label: currentRoute.sha.slice(0, 8) });
      if (currentRoute.name === 'mr') crumbs.push({ label: `!${currentRoute.number}` });
      crumbs.forEach((c, i) => {
        const last = i === crumbs.length - 1;
        if (i) breadcrumb.append(sep());
        breadcrumb.append(last
          ? h('span', { class: 'crumb-current ellipsis', 'aria-current': 'page' }, c.label)
          : h('a', { href: c.href, class: 'ellipsis' }, c.label));
      });
      document.title = `${project?.name || 'Projet'} · GitPilot`;
    } else {
      breadcrumb.append(h('span', { class: 'crumb-current', 'aria-current': 'page' }, 'Dashboard'));
      document.title = 'GitPilot';
    }
  }

  /* ---------- Cloche : exécutions récentes ---------- */
  function updateRunsBadge() {
    const n = State.runningCount();
    runsBadge.textContent = String(n);
    runsBadge.classList.toggle('hidden', n === 0);
    runsBtn.title = n ? `${n} action(s) en cours` : 'Exécutions récentes';
  }

  function openRunsPopover() {
    const runs = State.allRuns().slice(0, 20);
    const items = [{ header: 'Exécutions récentes' }];
    if (!runs.length) {
      items.push({ element: h('div', { class: 'empty-inline' }, 'Aucune action exécutée pendant cette session.') });
    }
    for (const r of runs) {
      items.push({
        element: h('div', {
          class: 'run-item',
          onclick: () => { UI.closeDropdown(); navigate(`/project/${r.projectId}?tab=actions&run=${r.id}`); },
        },
          UI.statusBadge(r.status).firstChild,
          h('div', { style: { minWidth: 0, flex: 1 } },
            h('div', { class: 'title ellipsis' }, r.actionName),
            h('div', { class: 'sub ellipsis' }, `${r.projectName} · ${formatTime(r.startedAt)}${r.endedAt ? ` · ${formatDuration(r.endedAt - r.startedAt)}` : ' · en cours'}`),
          ),
        ),
      });
    }
    UI.dropdown(runsBtn, items, { className: 'runs-pop' });
  }

  /* ---------- Paramètres ---------- */
  function openSettings() {
    const s = State.settings;
    const info = State.info;
    const shellSelect = h('select', { class: 'select' },
      info.shells.map((sh) => h('option', { value: sh.id, disabled: !sh.available }, `${sh.label}${sh.available ? '' : ' — introuvable'}`)));
    shellSelect.value = s.defaultShell;
    const timeoutInput = h('input', { class: 'input', type: 'number', min: '1', max: '240', value: String(s.timeoutMinutes), style: { maxWidth: '140px' } });
    const fetchCheck = h('input', { type: 'checkbox' });
    fetchCheck.checked = s.fetchOnOpen;
    const traceCheck = h('input', { type: 'checkbox' });
    traceCheck.checked = s.bashTrace;

    const saveBtn = h('button', { class: 'btn btn-primary', type: 'submit', form: 'settings-form' }, 'Enregistrer');
    const accountsSection = Accounts.settingsSection();
    const sshSection = SshSetup.settingsSection();
    const form = h('form', { id: 'settings-form' },
      h('div', { class: 'field' },
        h('label', null, 'Shell par défaut des actions'), shellSelect,
        h('div', { class: 'hint' }, 'Utilisé par les actions configurées sur « Par défaut ».'),
      ),
      h('div', { class: 'field' },
        h('label', null, "Délai maximal d'exécution (minutes)"), timeoutInput,
        h('div', { class: 'hint' }, 'Au-delà, le script et ses processus enfants sont arrêtés.'),
      ),
      h('div', { class: 'field' }, h('label', { class: 'checkbox' }, fetchCheck,
        h('span', null, "Lancer git fetch à l'ouverture d'un projet", h('div', { class: 'hint', style: { margin: 0 } }, 'Au plus une fois toutes les 2 minutes par projet.')))),
      h('div', { class: 'field' }, h('label', { class: 'checkbox' }, traceCheck,
        h('span', null, 'Afficher les commandes exécutées (Bash)', h('div', { class: 'hint', style: { margin: 0 } }, 'Chaque commande est affichée précédée de « > » dans la sortie.')))),
      h('h3', { style: { margin: '24px 0 10px', fontSize: '14px' } }, 'Comptes GitLab / GitHub'),
      accountsSection.el,
      h('h3', { style: { margin: '24px 0 10px', fontSize: '14px' } }, 'Accès SSH aux dépôts'),
      sshSection.el,
      h('h3', { style: { margin: '24px 0 10px', fontSize: '14px' } }, 'À propos'),
      h('dl', { class: 'kv' },
        h('dt', null, 'Version'), h('dd', null, info.version),
        h('dt', null, 'Git'), h('dd', null, info.gitVersion || 'introuvable'),
        h('dt', null, 'Configuration'), h('dd', { class: 'mono' }, info.dataFile),
      ),
    );

    const m = UI.modal({
      title: 'Paramètres',
      body: form,
      footer: [h('button', { class: 'btn', type: 'button', onclick: () => m.tryClose() }, 'Annuler'), saveBtn],
      onClose: () => { accountsSection.destroy(); sshSection.destroy(); },
    });

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      try {
        State.settings = await window.gitpilot.settings.update({
          defaultShell: shellSelect.value,
          timeoutMinutes: Number(timeoutInput.value),
          fetchOnOpen: fetchCheck.checked,
          bashTrace: traceCheck.checked,
        });
        m.close();
        UI.toast('Paramètres enregistrés.', 'success');
      } catch (err) {
        UI.toast(err.message, 'danger');
      }
    });
  }

  /* ---------- Démarrage ---------- */
  async function init() {
    document.getElementById('brand-logo').innerHTML = LOGO_SVG;
    runsBtn.insertAdjacentHTML('afterbegin', icon('bell'));
    settingsBtn.innerHTML = icon('settings');
    runsBtn.addEventListener('click', openRunsPopover);
    settingsBtn.addEventListener('click', openSettings);

    try {
      const [info, settings] = await Promise.all([window.gitpilot.app.info(), window.gitpilot.settings.get()]);
      State.info = info;
      State.settings = settings;
      await Promise.all([State.loadProjects(), State.loadSchedules()]);
      for (const run of await window.gitpilot.runs.list()) State.trackRun(run);
    } catch (err) {
      view.append(h('div', { class: 'page' }, UI.alert('danger', err.message, "Impossible d'initialiser l'application")));
      return;
    }

    if (!State.info.gitVersion) {
      UI.toast("Git est introuvable : installez Git et vérifiez qu'il est accessible dans le PATH.", 'danger', { timeout: 30000 });
    }

    State.on('run-status', (run) => {
      updateRunsBadge();
      // Notifie la fin d'une action si l'utilisateur regarde ailleurs.
      if (run.status !== 'running' && !(currentRoute.name === 'project' && currentRoute.id === run.projectId)) {
        const label = { success: 'terminée avec succès', error: 'en échec', cancelled: 'annulée' }[run.status];
        UI.toast(`« ${run.actionName} » (${run.projectName}) ${label}.`, run.status === 'success' ? 'success' : 'warning');
      }
    });
    State.on('projects', renderBreadcrumb);
    updateRunsBadge();

    window.addEventListener('hashchange', route);
    route();
  }

  init();
  return { navigate };
})();
