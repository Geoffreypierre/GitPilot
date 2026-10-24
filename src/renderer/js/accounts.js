'use strict';

/**
 * Comptes GitLab / GitHub, un par hôte : connexion OAuth (flux « device ») quand elle
 * est configurée pour le serveur, sinon par jeton d'accès personnel. Les jetons restent
 * dans le processus principal et ne sont jamais relus ici.
 */
const Accounts = (() => {
  const providerOf = (host) => (String(host).trim().toLowerCase() === 'github.com' ? 'github' : 'gitlab');
  const providerLabel = (provider) => (provider === 'github' ? 'GitHub' : 'GitLab');

  /** Ouvre la modale de connexion ; résout avec le compte connecté ou null. */
  function openConnectModal(defaultHost = '') {
    return new Promise((resolve) => {
      let connected = null;
      let flowId = null;
      let provider = defaultHost ? providerOf(defaultHost) : 'gitlab';

      /* ----- Choix du serveur : deux cartes radio ----- */
      const card = (value, title, sub) => {
        const radio = h('input', { type: 'radio', name: 'provider', value, class: 'sr-only' });
        radio.checked = value === provider;
        radio.addEventListener('change', () => { provider = value; sync(); });
        return h('label', { class: 'provider-card', dataset: { provider: value } },
          radio,
          h('span', { class: `provider-logo provider-${value}`, html: icon(value) }),
          h('span', { class: 'provider-text' }, h('span', { class: 'provider-title' }, title), h('span', { class: 'provider-sub' }, sub)),
          h('span', { class: 'provider-check', html: icon('checkCircle') }),
        );
      };
      const cards = h('div', { class: 'provider-cards', role: 'radiogroup', 'aria-label': 'Serveur' },
        card('github', 'GitHub', 'github.com'),
        card('gitlab', 'GitLab', 'gitlab.com ou serveur d’entreprise'),
      );

      const hostInput = h('input', { class: 'input mono', placeholder: 'gitlab.com', value: defaultHost && providerOf(defaultHost) === 'gitlab' ? defaultHost : 'gitlab.com', spellcheck: 'false' });
      const hostField = h('div', { class: 'field' }, h('label', null, 'Adresse du serveur GitLab'), hostInput);
      const host = () => (provider === 'github' ? 'github.com' : hostInput.value.trim() || 'gitlab.com');

      /* ----- Connexion OAuth ----- */
      const oauthBtn = h('button', { class: 'btn btn-accent btn-block', type: 'button', onclick: () => startOAuth() });
      const oauthNote = h('div', { class: 'hint' });
      const oauthBlock = h('div', { class: 'field' }, oauthBtn, oauthNote);

      /* ----- Connexion par jeton ----- */
      const tokenInput = h('input', { class: 'input mono', type: 'password', placeholder: 'glpat-… ou ghp_…', autocomplete: 'off', spellcheck: 'false' });
      const pageBtn = h('button', { class: 'btn btn-sm', type: 'button', html: `${icon('external')}<span></span>` });
      const scopeHint = h('div', { class: 'hint' });
      pageBtn.addEventListener('click', async () => {
        try {
          await window.gitpilot.accounts.openTokenPage(host());
          tokenInput.focus();
        } catch (err) { UI.toast(err.message, 'danger'); }
      });
      const tokenBlock = h('div', null,
        h('div', { class: 'field' },
          h('label', null, '1. Créez un jeton (la page s’ouvre pré-remplie)'),
          pageBtn,
          scopeHint,
        ),
        h('div', { class: 'field', style: { marginBottom: 0 } },
          h('label', null, '2. Collez-le ici'),
          tokenInput,
        ),
      );
      const tokenToggle = h('button', { class: 'btn-link', type: 'button' });
      const tokenSection = h('div', { class: 'token-section' }, tokenToggle, tokenBlock);
      let tokenOpen = false;
      tokenToggle.addEventListener('click', () => { tokenOpen = !tokenOpen; sync(); if (tokenOpen) tokenInput.focus(); });

      /* ----- Attente de l'autorisation OAuth ----- */
      const codeEl = h('div', { class: 'device-code mono' });
      const waitPanel = h('div', { class: 'device-panel', hidden: true },
        h('p', { style: { marginTop: 0 } }, 'Une page s’est ouverte dans votre navigateur. Saisissez-y ce code si elle le demande, puis autorisez GitPilot :'),
        codeEl,
        h('div', { class: 'device-actions' },
          h('button', { class: 'btn btn-sm', type: 'button', html: `${icon('copy')}<span>Copier le code</span>`, onclick: () => copyCode() }),
          h('button', { class: 'btn btn-sm', type: 'button', html: `${icon('external')}<span>Rouvrir la page</span>`, onclick: () => flowId && window.gitpilot.accounts.oauthOpen(flowId) }),
        ),
        h('div', { class: 'inline-spinner', style: { justifyContent: 'center', marginTop: '14px' } }, h('span', { class: 'spinner' }), 'En attente de l’autorisation…'),
      );

      const errorBox = h('div');
      const choosePanel = h('div', null, cards, hostField, oauthBlock, tokenSection);
      const submitBtn = h('button', { class: 'btn btn-primary', type: 'submit', form: 'connect-form' }, 'Connecter avec le jeton');
      const form = h('form', { id: 'connect-form', novalidate: true }, errorBox, choosePanel, waitPanel);

      let oauthOk = false;
      let checkSeq = 0;
      async function refreshOAuthAvailability() {
        const seq = ++checkSeq;
        let ok = false;
        try { ok = await window.gitpilot.accounts.oauthAvailable(host()); } catch { ok = false; }
        if (seq !== checkSeq) return;
        oauthOk = ok;
        sync();
      }

      function sync() {
        const label = providerLabel(provider);
        for (const el of cards.children) el.classList.toggle('selected', el.dataset.provider === provider);
        hostField.hidden = provider === 'github';
        oauthBtn.innerHTML = `${icon(provider)}<span>Se connecter avec ${label}</span>`;
        oauthBtn.disabled = !oauthOk;
        oauthNote.textContent = oauthOk
          ? 'Le navigateur s’ouvre : il suffit d’autoriser GitPilot. Aucun mot de passe n’est saisi ici. Pour ajouter un autre compte, connectez-vous d’abord avec ce compte dans le navigateur.'
          : `Connexion ${label} en un clic non configurée pour ${host()} : utilisez un jeton d’accès ci-dessous.`;
        // Sans OAuth, le jeton est la seule méthode : on l'affiche directement.
        const showToken = tokenOpen || !oauthOk;
        tokenBlock.hidden = !showToken;
        tokenToggle.hidden = !oauthOk;
        tokenToggle.textContent = tokenOpen ? 'Masquer la connexion par jeton' : 'Ou se connecter avec un jeton d’accès';
        submitBtn.hidden = !showToken || !waitPanel.hidden;
        pageBtn.lastChild.textContent = `Créer un jeton sur ${host()}`;
        scopeHint.textContent = provider === 'github'
          ? 'Jeton « classic » avec le droit repo (lecture des dépôts privés).'
          : 'Jeton avec le droit api (lecture, création de merge requests et de threads).';
      }

      cards.addEventListener('change', refreshOAuthAvailability);
      hostInput.addEventListener('input', debounce(refreshOAuthAvailability, 250));
      sync();
      refreshOAuthAvailability();

      const m = UI.modal({
        title: 'Connecter un compte',
        body: form,
        footer: [h('button', { class: 'btn', type: 'button', onclick: () => m.tryClose() }, 'Annuler'), submitBtn],
        onClose: () => {
          if (flowId) window.gitpilot.accounts.oauthCancel(flowId).catch(() => {});
          resolve(connected);
        },
      });

      function done(account) {
        connected = account;
        flowId = null;
        m.busy = false;
        m.close();
        State.emit('accounts');
        UI.toast(`Connecté à ${account.host}${account.username ? ` en tant que ${account.username}` : ''}.`, 'success');
        if (!account.persistent) {
          UI.toast('Aucun trousseau sécurisé disponible : la connexion sera oubliée à la fermeture de GitPilot.', 'warning', { timeout: 12000 });
        }
      }

      function showError(err) {
        clear(errorBox);
        errorBox.append(UI.alert('danger', err.message));
      }

      async function copyCode() {
        try {
          await navigator.clipboard.writeText(codeEl.textContent);
          UI.toast('Code copié dans le presse-papiers.', 'success');
        } catch { /* copie impossible : le code reste affiché */ }
      }

      async function startOAuth() {
        clear(errorBox);
        UI.setLoading(oauthBtn, true, 'Ouverture du navigateur…');
        let flow;
        try {
          flow = await window.gitpilot.accounts.oauthStart(host());
        } catch (err) {
          UI.setLoading(oauthBtn, false);
          sync();
          showError(err);
          return;
        }
        UI.setLoading(oauthBtn, false);
        flowId = flow.flowId;
        codeEl.textContent = flow.userCode;
        choosePanel.hidden = true;
        waitPanel.hidden = false;
        sync();
        copyCode();
        try {
          done(await window.gitpilot.accounts.oauthWait(flow.flowId));
        } catch (err) {
          if (flowId !== flow.flowId) return; // modale fermée ou nouvelle tentative
          flowId = null;
          waitPanel.hidden = true;
          choosePanel.hidden = false;
          sync();
          showError(err);
        }
      }

      form.addEventListener('submit', async (e) => {
        e.preventDefault();
        clear(errorBox);
        if (!tokenInput.value.trim()) { errorBox.append(UI.alert('danger', "Collez le jeton d'accès.")); tokenInput.focus(); return; }
        m.busy = true;
        UI.setLoading(submitBtn, true, 'Vérification…');
        try {
          const account = await window.gitpilot.accounts.connect({ host: host(), token: tokenInput.value });
          tokenInput.value = '';
          done(account);
        } catch (err) {
          m.busy = false;
          UI.setLoading(submitBtn, false);
          showError(err);
        }
      });
    });
  }

  /** Liste des comptes pour la fenêtre Paramètres (se met à jour seule). */
  function settingsSection() {
    const list = h('div', { class: 'account-list' });

    async function render() {
      let accounts = [];
      try { accounts = await window.gitpilot.accounts.list(); } catch (err) { UI.toast(err.message, 'danger'); }
      clear(list);
      if (!accounts.length) list.append(h('div', { class: 'muted', style: { fontSize: '13px' } }, 'Aucun compte connecté.'));
      const perHost = accounts.reduce((m, a) => m.set(a.host, (m.get(a.host) || 0) + 1), new Map());
      for (const a of accounts) {
        const several = perHost.get(a.host) > 1;
        list.append(h('div', { class: `account-item ${a.active && several ? 'is-active' : ''}` },
          h('span', { class: `provider-logo provider-${a.provider} sm`, html: icon(a.provider) }),
          h('span', { class: 'mono ellipsis' }, a.host),
          a.username ? h('strong', { class: 'ellipsis' }, `@${a.username}`) : null,
          h('span', { class: 'badge badge-muted' }, a.method === 'oauth' ? 'OAuth' : 'jeton'),
          a.persistent ? null : h('span', { class: 'badge badge-warning', title: 'Aucun trousseau sécurisé : la connexion sera oubliée à la fermeture.' }, 'session'),
          h('div', { class: 'account-actions' },
            several && a.active ? h('span', { class: 'badge badge-success', title: `Compte utilisé pour ${a.host}` }, 'actif') : null,
            several && !a.active ? h('button', {
              class: 'btn btn-sm', type: 'button', title: `Utiliser ce compte pour ${a.host}`,
              onclick: async () => {
                try {
                  await window.gitpilot.accounts.setActive(a.host, a.username);
                  State.emit('accounts');
                } catch (err) { UI.toast(err.message, 'danger'); }
              },
            }, 'Utiliser') : null,
            h('button', {
              class: 'btn btn-sm btn-icon btn-tertiary', type: 'button', title: `Déconnecter @${a.username}`, html: icon('close'),
              onclick: async () => {
                try {
                  await window.gitpilot.accounts.remove(a.host, a.username);
                  State.emit('accounts');
                } catch (err) { UI.toast(err.message, 'danger'); }
              },
            })),
        ));
      }
    }

    const off = State.on('accounts', render);
    render();
    return {
      el: h('div', null,
        list,
        h('button', { class: 'btn btn-sm', type: 'button', style: { marginTop: '8px' }, onclick: () => openConnectModal(), html: `${icon('plus')}<span>Connecter un compte</span>` }),
      ),
      destroy: off,
    };
  }

  /**
   * Bandeau « Vous agissez en tant que @compte sur hôte », avec changement de compte.
   * Les actions faites depuis GitPilot (MR, threads…) sont enregistrées sur la plateforme
   * au nom du compte actif.
   */
  function identityBar(host, { onChange } = {}) {
    const el = h('div', { class: 'identity-bar' });
    async function render() {
      let list = [];
      try { list = (await window.gitpilot.accounts.list()).filter((a) => a.host === host); } catch { list = []; }
      clear(el);
      const active = list.find((a) => a.active);
      el.hidden = !active;
      if (!active) return;
      const switchBtn = h('button', { class: 'btn btn-sm btn-tertiary', type: 'button', html: `<span>Changer de compte</span>${icon('chevronDown')}` });
      switchBtn.addEventListener('click', () => UI.dropdown(switchBtn, [
        { header: `Comptes ${host}` },
        ...list.map((a) => ({
          label: `@${a.username}${a.active ? ' (actif)' : ''}`,
          icon: a.active ? 'checkCircle' : a.provider,
          onClick: async () => {
            if (a.active) return;
            try {
              await window.gitpilot.accounts.setActive(host, a.username);
              State.emit('accounts');
              UI.toast(`Vous agissez maintenant en tant que @${a.username} sur ${host}.`, 'success');
              onChange?.();
            } catch (err) { UI.toast(err.message, 'danger'); }
          },
        })),
        'sep',
        { label: 'Ajouter un compte…', icon: 'plus', onClick: async () => { if (await openConnectModal(host)) onChange?.(); } },
      ]));
      el.append(
        h('span', { class: `provider-logo provider-${active.provider} sm`, html: icon(active.provider) }),
        h('span', null, 'Vous agissez en tant que ', h('strong', null, `@${active.username}`), ` sur ${host}`),
        switchBtn,
      );
    }
    render();
    return el;
  }

  return { openConnectModal, settingsSection, providerLabel, identityBar };
})();
