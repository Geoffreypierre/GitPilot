'use strict';

/**
 * Assistant d'accès SSH aux dépôts : détecte une clé acceptée par le serveur, ou crée
 * une clé dédiée à ajouter au compte. La configuration ne s'applique qu'à GitPilot
 * (fetch, suppression de branches, actions) : la configuration Git globale n'est pas modifiée.
 */
const SshSetup = (() => {
  const basename = (p) => String(p).split(/[\\/]/).pop();
  const loading = (text) => h('div', { class: 'loading-block' }, h('span', { class: 'spinner spinner-lg' }), text);

  /** Ouvre l'assistant pour le remote SSH du projet ; résout avec true si l'accès a été configuré. */
  function open(project) {
    return new Promise((resolve) => {
      let configured = false;
      let keyPath = null;
      const body = h('div', { class: 'ssh-wizard' });
      const primaryBtn = h('button', { class: 'btn btn-accent', type: 'button', hidden: true });
      const m = UI.modal({
        title: 'Configurer l’accès SSH',
        body,
        footer: [h('button', { class: 'btn', type: 'button', onclick: () => m.tryClose() }, 'Fermer'), primaryBtn],
        onClose: () => resolve(configured),
      });

      const step = (...children) => { clear(body); body.append(...children); };
      const setPrimary = (label, fn) => {
        primaryBtn.hidden = !label;
        primaryBtn.textContent = label || '';
        primaryBtn.onclick = fn || null;
      };

      async function use(identity) {
        try {
          await window.gitpilot.ssh.use({ identity });
          configured = true;
          m.close();
          UI.toast('Accès SSH configuré pour GitPilot.', 'success');
          State.emit('ssh');
        } catch (err) {
          UI.toast(err.message, 'danger');
        }
      }

      async function detect() {
        setPrimary(null);
        step(loading('Recherche d’une clé SSH acceptée par le serveur…'));
        let res;
        try {
          res = await window.gitpilot.ssh.detect(project.id);
        } catch (err) {
          step(UI.alert('danger', err.message));
          return;
        }
        if (res.ok) {
          const how = res.identity ? `la clé ${basename(res.identity)}`
            : res.method === 'agent' ? 'la clé chargée dans l’agent SSH de Windows' : 'votre configuration SSH';
          step(
            UI.alert('info', `${res.host} accepte ${how}. GitPilot l’utilisera pour les fetch, la suppression de branches et les actions de vos projets.`, 'Accès SSH trouvé'),
            h('p', { class: 'muted', style: { fontSize: '13px', marginBottom: 0 } }, 'Votre configuration Git globale n’est pas modifiée.'),
          );
          setPrimary('Utiliser cette configuration', () => use(res.identity));
        } else {
          step(
            UI.alert('warning', `Aucune clé SSH de cet ordinateur n’est acceptée par ${res.host}.`, 'Accès SSH refusé'),
            h('p', { style: { marginBottom: 0 } }, 'GitPilot peut créer une clé dédiée. Il suffira de la coller dans la page de votre compte qui s’ouvrira.'),
          );
          setPrimary('Créer une clé pour GitPilot', createKey);
        }
      }

      async function copyKey(text) {
        try {
          await navigator.clipboard.writeText(text);
          UI.toast('Clé publique copiée dans le presse-papiers.', 'success');
        } catch { /* la clé reste sélectionnable dans le champ */ }
      }

      async function createKey() {
        setPrimary(null);
        step(loading('Création de la clé…'));
        let key;
        try {
          key = await window.gitpilot.ssh.generateKey(project.id);
        } catch (err) {
          step(UI.alert('danger', err.message));
          return;
        }
        keyPath = key.path;
        const result = h('div');
        const pub = h('textarea', { class: 'textarea mono ssh-pubkey', rows: '3', readonly: true, value: key.publicKey, onfocus: (e) => e.target.select() });
        step(
          h('ol', { class: 'ssh-steps' },
            h('li', null,
              h('div', null, 'Copiez la clé publique (déjà copiée dans le presse-papiers) :'),
              pub,
              h('button', { class: 'btn btn-sm', type: 'button', html: `${icon('copy')}<span>Copier la clé</span>`, onclick: () => copyKey(key.publicKey) }),
            ),
            h('li', null,
              h('div', null, `Ajoutez-la à votre compte ${key.host} :`),
              h('button', { class: 'btn btn-sm', type: 'button', html: `${icon('external')}<span>Ouvrir la page d’ajout de clé</span>`, onclick: () => window.gitpilot.ssh.openKeyPage(project.id).catch((err) => UI.toast(err.message, 'danger')) }),
            ),
            h('li', null, 'Revenez ici et cliquez sur « Vérifier ».'),
          ),
          result,
          h('p', { class: 'muted', style: { fontSize: '12px', marginBottom: 0 } },
            `Clé enregistrée dans ${key.path}, sans phrase de passe : elle protège l’accès à vos dépôts, ne la partagez pas.`),
        );
        copyKey(key.publicKey);
        setPrimary('Vérifier', () => verify(result));
      }

      async function verify(result) {
        clear(result);
        UI.setLoading(primaryBtn, true, 'Vérification…');
        try {
          const r = await window.gitpilot.ssh.test(project.id, { identity: keyPath });
          UI.setLoading(primaryBtn, false);
          if (r.ok) {
            await use(keyPath);
            return;
          }
          result.append(UI.alert('warning', `La clé n’est pas encore acceptée${r.message ? ` (${r.message})` : ''}. Vérifiez qu’elle a bien été ajoutée à votre compte, puis réessayez.`));
        } catch (err) {
          UI.setLoading(primaryBtn, false);
          result.append(UI.alert('danger', err.message));
        }
      }

      detect();
    });
  }

  /** Statut pour la fenêtre Paramètres. */
  function settingsSection() {
    const el = h('div', { class: 'ssh-status' });

    async function render() {
      let status;
      try { status = await window.gitpilot.ssh.status(); } catch (err) { UI.toast(err.message, 'danger'); return; }
      clear(el);
      if (!status.enabled) {
        el.append(h('div', { class: 'muted', style: { fontSize: '13px' } },
          'GitPilot utilise la configuration SSH de votre système. Si un fetch échoue à cause de la clé SSH, un assistant vous est proposé.'));
        return;
      }
      const keys = status.identities.length ? ` + ${status.identities.map(basename).join(', ')}` : '';
      el.append(h('div', { class: 'account-item' },
        h('span', { class: 'badge badge-info' }, 'Géré par GitPilot'),
        h('span', { class: 'mono ellipsis', title: status.client || '' }, `${basename(status.client || 'ssh')}${keys}`),
        h('button', {
          class: 'btn btn-sm btn-tertiary', type: 'button', style: { marginLeft: 'auto' },
          onclick: async () => {
            try {
              await window.gitpilot.ssh.disable();
              State.emit('ssh');
            } catch (err) { UI.toast(err.message, 'danger'); }
          },
        }, 'Désactiver'),
      ));
    }

    const off = State.on('ssh', render);
    render();
    return { el, destroy: off };
  }

  return { open, settingsSection };
})();
