export {};

export {};

const menu = document.querySelector<HTMLDetailsElement>('[data-doc-menu]');
const mobile = matchMedia('(max-width: 800px)');

function syncMenu() {
  if (menu) menu.open = !mobile.matches;
}

syncMenu();
mobile.addEventListener('change', syncMenu);

const searchInput = document.querySelector<HTMLInputElement>('[data-doc-search-input]');
const searchResults = document.querySelector<HTMLElement>('[data-doc-search-results]');
const searchStatus = document.querySelector<HTMLElement>('[data-doc-search-status]');
const navigation = document.querySelector<HTMLElement>('[data-doc-nav]');
const searchEntries = [...document.querySelectorAll<HTMLElement>('[data-doc-search-entry]')];

function searchDocs() {
  const terms = (searchInput?.value ?? '').trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (!searchResults || !navigation) return;
  searchResults.hidden = terms.length === 0;
  navigation.hidden = terms.length > 0;
  let count = 0;
  for (const entry of searchEntries) {
    const matches = terms.every(term => entry.dataset.search?.includes(term));
    entry.hidden = !matches;
    if (matches) count++;
  }
  if (searchStatus) searchStatus.textContent = count === 0 ? 'No matching docs. Try another term.' : `${count} ${count === 1 ? 'result' : 'results'}`;
}

searchInput?.addEventListener('input', searchDocs);
searchInput?.addEventListener('keydown', event => {
  if (event.key === 'Escape') {
    searchInput.value = '';
    searchDocs();
  }
  if (event.key === 'ArrowDown' && !searchResults?.hidden) {
    event.preventDefault();
    searchResults?.querySelector<HTMLAnchorElement>('li:not([hidden]) a')?.focus();
  }
});

document.addEventListener('keydown', event => {
  const target = event.target as HTMLElement;
  if (event.key === '/' && !event.ctrlKey && !event.metaKey && !event.altKey && !target.closest('input, textarea, select, [contenteditable="true"]')) {
    event.preventDefault();
    if (menu) menu.open = true;
    searchInput?.focus();
  }
});

document.querySelectorAll<HTMLElement>('[data-doc-code]').forEach(example => {
  const tabs = [...example.querySelectorAll<HTMLButtonElement>('[data-doc-tab]')];
  const panels = [...example.querySelectorAll<HTMLElement>('[data-doc-panel]')];
  const tablist = example.querySelector<HTMLElement>('[data-doc-tabs]');
  const copyButton = example.querySelector<HTMLButtonElement>('[data-doc-copy]');
  const copyLabel = example.querySelector<HTMLElement>('[data-copy-label]');
  const copyStatus = example.querySelector<HTMLElement>('[data-copy-status]');
  let activePanel = panels[0];
  let feedbackTimeout: ReturnType<typeof setTimeout> | undefined;

  function activateTab(index: number, focus = false) {
    activePanel = panels[index];
    tabs.forEach((tab, tabIndex) => {
      const selected = tabIndex === index;
      tab.setAttribute('aria-selected', String(selected));
      tab.tabIndex = selected ? 0 : -1;
      panels[tabIndex].hidden = !selected;
    });
    if (focus) tabs[index].focus();
    if (copyLabel) copyLabel.textContent = 'Copy';
    if (copyStatus) copyStatus.textContent = '';
    clearTimeout(feedbackTimeout);
  }

  if (tablist && tabs.length > 1) {
    tablist.setAttribute('role', 'tablist');
    tabs.forEach((tab, index) => {
      tab.setAttribute('role', 'tab');
      tab.setAttribute('aria-controls', panels[index].id);
      panels[index].setAttribute('role', 'tabpanel');
      panels[index].setAttribute('aria-labelledby', tab.id);
      panels[index].tabIndex = 0;
      tab.addEventListener('click', () => activateTab(index));
      tab.addEventListener('keydown', event => {
        let next = index;
        if (event.key === 'ArrowRight') next = (index + 1) % tabs.length;
        else if (event.key === 'ArrowLeft') next = (index - 1 + tabs.length) % tabs.length;
        else if (event.key === 'Home') next = 0;
        else if (event.key === 'End') next = tabs.length - 1;
        else return;
        event.preventDefault();
        activateTab(next, true);
      });
    });
    activateTab(0);
  }

  copyButton?.addEventListener('click', async () => {
    const code = activePanel?.querySelector('code');
    if (!code) return;
    clearTimeout(feedbackTimeout);
    try {
      await navigator.clipboard.writeText(code.textContent ?? '');
      if (copyLabel) copyLabel.textContent = 'Copied';
      if (copyStatus) copyStatus.textContent = `${activePanel.dataset.codeLabel} example copied.`;
    } catch {
      const selection = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(code);
      selection?.removeAllRanges();
      selection?.addRange(range);
      if (copyLabel) copyLabel.textContent = 'Select & copy';
      if (copyStatus) copyStatus.textContent = 'Code selected. Use your device copy command.';
    }
    feedbackTimeout = setTimeout(() => {
      if (copyLabel) copyLabel.textContent = 'Copy';
    }, 2500);
  });

  example.classList.add('docs-enhanced');
});

const tocLinks = [...document.querySelectorAll<HTMLAnchorElement>('[data-doc-toc]')];
const sections = [...document.querySelectorAll<HTMLElement>('.docs-section[id]')];
if ('IntersectionObserver' in window) {
  const observer = new IntersectionObserver(entries => {
    const visible = entries.find(entry => entry.isIntersecting);
    if (!visible) return;
    tocLinks.forEach(link => {
      if (link.dataset.docToc === visible.target.id) link.setAttribute('aria-current', 'location');
      else link.removeAttribute('aria-current');
    });
  }, { rootMargin: '-10% 0px -65% 0px', threshold: 0 });
  sections.forEach(section => observer.observe(section));
}

document.documentElement.classList.add('docs-ready');
