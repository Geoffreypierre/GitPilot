'use strict';

/**
 * Rendu Markdown (GitLab / GitHub) des descriptions de merge request et des commentaires.
 * Ces textes viennent de tiers : le HTML produit par marked est nettoyé par DOMPurify
 * avant insertion (scripts, gestionnaires d'événements, iframes… supprimés).
 */
const Markdown = (() => {
  const SANITIZE = {
    USE_PROFILES: { html: true },
    ADD_TAGS: ['details', 'summary'],
    FORBID_TAGS: ['style', 'form', 'input', 'button', 'textarea', 'select', 'iframe', 'object', 'embed'],
    FORBID_ATTR: ['style'],
  };

  const plain = (text) => h('div', { class: 'md md-plain' }, text);

  /** Renvoie un élément contenant le Markdown rendu (texte brut si les bibliothèques manquent). */
  function render(text) {
    const source = String(text || '');
    if (typeof marked === 'undefined' || typeof DOMPurify === 'undefined') return plain(source);
    let html;
    try {
      html = marked.parse(source, { gfm: true, breaks: true, async: false });
    } catch {
      return plain(source);
    }
    // Transformation dans un document inerte (DOMParser) : aucune ressource n'y est
    // chargée. Les images sont remplacées avant l'insertion dans la page.
    const doc = new DOMParser().parseFromString(DOMPurify.sanitize(html, SANITIZE), 'text/html');

    // Images : la CSP interdit les images distantes ; on garde leur texte alternatif, lié à l'image.
    for (const img of doc.querySelectorAll('img')) {
      const alt = img.getAttribute('alt') || 'image';
      const src = img.getAttribute('src') || '';
      const label = doc.createElement('span');
      label.className = 'md-img';
      label.title = src;
      label.textContent = alt;
      if (!img.closest('a') && /^https:\/\//i.test(src)) {
        const link = doc.createElement('a');
        link.setAttribute('href', src);
        link.append(label);
        img.replaceWith(link);
      } else {
        img.replaceWith(label);
      }
    }

    // Tableaux larges : défilement horizontal dans un conteneur.
    for (const table of doc.querySelectorAll('table')) {
      const wrap = doc.createElement('div');
      wrap.className = 'md-table';
      table.replaceWith(wrap);
      wrap.append(table);
    }

    // Contenu nettoyé par DOMPurify et sans image : il peut rejoindre la page.
    const el = h('div', { class: 'md' }, [...doc.body.childNodes].map((n) => document.importNode(n, true)));
    for (const label of el.querySelectorAll('.md-img')) label.prepend(iconEl('external'));

    // Liens : ouverts dans le navigateur (jamais dans la fenêtre de GitPilot).
    for (const a of el.querySelectorAll('a[href]')) {
      const href = a.getAttribute('href');
      a.removeAttribute('target');
      a.title = href;
      a.addEventListener('click', (e) => {
        e.preventDefault();
        if (/^https?:\/\//i.test(href)) window.gitpilot.app.openUrl(href.replace(/^http:/i, 'https:'));
      });
    }

    // Blocs de code : coloration syntaxique si le langage est indiqué.
    if (typeof hljs !== 'undefined') {
      for (const code of el.querySelectorAll('pre code')) {
        const lang = [...code.classList].find((c) => c.startsWith('language-'))?.slice(9);
        if (lang && hljs.getLanguage(lang)) {
          code.innerHTML = hljs.highlight(code.textContent, { language: lang, ignoreIllegals: true }).value;
        }
      }
    }
    return el;
  }

  return { render };
})();
