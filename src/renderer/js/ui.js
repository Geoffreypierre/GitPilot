'use strict';

const UI = (() => {
  const modalRoot = () => document.getElementById('modal-root');
  const popoverRoot = () => document.getElementById('popover-root');
  const toastRoot = () => document.getElementById('toast-root');
  const openModals = [];

  /* ---------- Modale générique ---------- */
  function modal({ title, body, footer, size, onClose, dismissable = true }) {
    const closeBtn = h('button', { class: 'icon-btn', 'aria-label': 'Fermer', html: icon('close') });
    const dialog = h('div', { class: `modal ${size === 'lg' ? 'modal-lg' : ''}`, role: 'dialog', 'aria-modal': 'true' },
      h('div', { class: 'modal-head' }, h('h2', { class: 'modal-title' }, title), closeBtn),
      h('div', { class: 'modal-body' }, body),
      footer ? h('div', { class: 'modal-foot' }, footer) : null,
    );
    const backdrop = h('div', { class: 'modal-backdrop' }, dialog);
    const previousFocus = document.activeElement;

    let closed = false;
    const api = {
      el: dialog,
      busy: false,
      close() {
        if (closed) return;
        closed = true;
        backdrop.remove();
        openModals.splice(openModals.indexOf(api), 1);
        if (previousFocus && previousFocus.focus) previousFocus.focus();
        onClose?.();
      },
      tryClose() {
        if (!api.busy && dismissable) api.close();
      },
    };

    closeBtn.addEventListener('click', () => api.tryClose());
    backdrop.addEventListener('mousedown', (e) => { if (e.target === backdrop) api.tryClose(); });
    openModals.push(api);
    modalRoot().append(backdrop);

    requestAnimationFrame(() => {
      const first = dialog.querySelector('[autofocus], input, textarea, select, .modal-foot .btn-primary, .modal-foot .btn-danger, .modal-foot .btn-accent');
      (first || closeBtn).focus();
    });
    return api;
  }

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      if (closeDropdown()) return;
      const top = openModals[openModals.length - 1];
      if (top) { e.preventDefault(); top.tryClose(); }
    }
  });

  /* ---------- Confirmation ---------- */
  function confirm({ title, message, confirmLabel = 'Confirmer', danger = false }) {
    return new Promise((resolve) => {
      let result = false;
      const ok = h('button', { class: `btn ${danger ? 'btn-danger' : 'btn-primary'}`, onclick: () => { result = true; m.close(); } }, confirmLabel);
      const cancel = h('button', { class: 'btn', onclick: () => m.close() }, 'Annuler');
      const m = modal({
        title,
        body: typeof message === 'string' ? h('p', { style: { margin: 0 } }, message) : message,
        footer: [cancel, ok],
        onClose: () => resolve(result),
      });
    });
  }

  /* ---------- Toasts ---------- */
  function toast(message, type = 'info', { timeout } = {}) {
    const iconName = { success: 'checkCircle', danger: 'xCircle', warning: 'warning', info: 'info' }[type] || 'info';
    const closeBtn = h('button', { class: 'icon-btn', 'aria-label': 'Fermer', html: icon('close') });
    const el = h('div', { class: `toast toast-${type}`, role: 'status' },
      iconEl(iconName),
      h('div', { class: 'toast-body' }, message),
      closeBtn,
    );
    const remove = () => el.remove();
    closeBtn.addEventListener('click', remove);
    toastRoot().append(el);
    while (toastRoot().children.length > 4) toastRoot().firstElementChild.remove();
    setTimeout(remove, timeout ?? (type === 'danger' || type === 'warning' ? 9000 : 4500));
  }

  /* ---------- Menus déroulants ---------- */
  let currentDropdown = null;

  function closeDropdown() {
    if (!currentDropdown) return false;
    currentDropdown.remove();
    currentDropdown = null;
    return true;
  }

  function positionNear(el, anchor, align = 'right') {
    const r = anchor.getBoundingClientRect();
    const width = el.offsetWidth;
    const height = el.offsetHeight;
    let left = align === 'right' ? r.right - width : r.left;
    let top = r.bottom + 4;
    if (top + height > window.innerHeight - 8) top = Math.max(8, r.top - height - 4);
    left = Math.min(Math.max(8, left), window.innerWidth - width - 8);
    el.style.left = `${left}px`;
    el.style.top = `${top}px`;
  }

  /** items : [{ label, icon, onClick, danger }] | 'sep' | { header } */
  function dropdown(anchor, items, { align = 'right', className = '' } = {}) {
    const wasSame = currentDropdown && currentDropdown.anchor === anchor;
    closeDropdown();
    if (wasSame) return null;

    const menu = h('div', { class: `dropdown ${className}`, role: 'menu' });
    for (const item of items) {
      if (item === 'sep') menu.append(h('div', { class: 'dropdown-sep' }));
      else if (item.header) menu.append(h('div', { class: 'dropdown-header' }, item.header));
      else if (item.element) menu.append(item.element);
      else {
        menu.append(h('button', {
          class: `dropdown-item ${item.danger ? 'danger' : ''}`,
          role: 'menuitem',
          onclick: (e) => { e.stopPropagation(); closeDropdown(); item.onClick?.(); },
        }, item.icon ? iconEl(item.icon) : null, item.label));
      }
    }
    menu.anchor = anchor;
    popoverRoot().append(menu);
    positionNear(menu, anchor, align);
    currentDropdown = menu;
    menu.querySelector('.dropdown-item')?.focus({ preventScroll: true });
    return menu;
  }

  document.addEventListener('mousedown', (e) => {
    if (currentDropdown && !currentDropdown.contains(e.target) && !currentDropdown.anchor.contains(e.target)) closeDropdown();
  });
  window.addEventListener('resize', closeDropdown);
  document.addEventListener('scroll', closeDropdown, true);

  /* ---------- Éléments réutilisables ---------- */
  function alert(type, message, title) {
    const iconName = { danger: 'xCircle', warning: 'warning', info: 'info', success: 'checkCircle' }[type];
    return h('div', { class: `alert alert-${type}` },
      iconEl(iconName),
      h('div', { class: 'alert-body' }, title ? h('div', { class: 'alert-title' }, title) : null, message),
    );
  }

  function statusBadge(status) {
    switch (status) {
      case 'running': return h('span', { class: 'status status-running' }, h('span', { class: 'spinner' }), 'En cours');
      case 'success': return h('span', { class: 'status status-success' }, iconEl('checkCircle'), 'Réussite');
      case 'error': return h('span', { class: 'status status-error' }, iconEl('xCircle'), 'Erreur');
      case 'cancelled': return h('span', { class: 'status status-cancelled' }, iconEl('minusCircle'), 'Annulée');
      default: return h('span', { class: 'status status-idle' }, iconEl('clock'), 'Jamais exécutée');
    }
  }

  function setLoading(button, loading, label) {
    if (loading) {
      button.dataset.label = button.dataset.label || button.innerHTML;
      button.disabled = true;
      button.innerHTML = '';
      button.append(h('span', { class: 'spinner' }), label || '');
    } else {
      button.disabled = false;
      if (button.dataset.label) button.innerHTML = button.dataset.label;
      delete button.dataset.label;
    }
  }

  return { modal, confirm, toast, dropdown, closeDropdown, alert, statusBadge, setLoading, positionNear };
})();
