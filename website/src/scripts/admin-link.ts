// Reveal the Admin link only for operators. Non-operators get 403/404 and never see it.
const link = document.querySelector<HTMLElement>('[data-admin-link]');
if (link) {
  fetch('/api/control/admin/session', { credentials: 'same-origin', headers: { Accept: 'application/json' } })
    .then(response => { if (response.ok) link.hidden = false; })
    .catch(() => {});
}
