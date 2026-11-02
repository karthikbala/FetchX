for (const group of document.querySelectorAll<HTMLElement>('[data-mkt-tabs]')) {
  const tabs = [...group.querySelectorAll<HTMLButtonElement>('[data-mkt-tab]')];
  const panels = [...group.querySelectorAll<HTMLElement>('[data-mkt-panel]')];
  function select(index: number, focus = false) {
    tabs.forEach((tab, i) => {
      tab.setAttribute('aria-selected', String(i === index));
      tab.tabIndex = i === index ? 0 : -1;
      if (panels[i]) panels[i].hidden = i !== index;
    });
    if (focus) tabs[index]?.focus();
  }
  tabs.forEach((tab, index) => {
    tab.addEventListener('click', () => select(index));
    tab.addEventListener('keydown', (event) => {
      let next = index;
      if (event.key === 'ArrowRight') next = (index + 1) % tabs.length;
      else if (event.key === 'ArrowLeft') next = (index - 1 + tabs.length) % tabs.length;
      else if (event.key === 'Home') next = 0;
      else if (event.key === 'End') next = tabs.length - 1;
      else return;
      event.preventDefault();
      select(next, true);
    });
  });
  const copy = group.querySelector<HTMLButtonElement>('[data-mkt-copy]');
  const label = copy?.querySelector<HTMLElement>('[data-mkt-copy-label]');
  const status = group.querySelector<HTMLElement>('[data-mkt-copy-status]');
  let reset: ReturnType<typeof setTimeout> | undefined;
  copy?.addEventListener('click', async () => {
    const code = panels.find((panel) => !panel.hidden)?.querySelector('code')?.textContent;
    if (!code) return;
    if (reset) clearTimeout(reset);
    try {
      await navigator.clipboard.writeText(code);
      if (label) label.textContent = 'Copied';
      if (status) status.textContent = 'Selected request example copied to clipboard.';
    } catch {
      if (label) label.textContent = 'Select code';
      if (status) status.textContent = 'Clipboard unavailable. Select and copy the code manually.';
    }
    reset = setTimeout(() => {
      if (label) label.textContent = 'Copy';
      if (status) status.textContent = '';
    }, 2500);
  });
}
