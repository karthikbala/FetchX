import type { DocPage } from '../data/api-docs';

export function docMarkdown(page: DocPage): string {
  const path = page.slug ? '/docs/' + page.slug : '/docs';
  const lines = ['# ' + page.title, '', page.description, '', 'Canonical page: https://fetchx.ai' + path, ''];
  if (page.method && page.endpoint) lines.push('`' + page.method + ' ' + page.endpoint + '`', '');
  for (const section of page.sections) {
    lines.push('## ' + section.title, '');
    for (const block of section.blocks) {
      switch (block.kind) {
        case 'text': lines.push(block.text, ''); break;
        case 'note': lines.push('> **' + block.title + '**', '> ' + block.text, ''); break;
        case 'link': lines.push('[' + block.label + '](https://fetchx.ai' + block.href + ')', ''); break;
        case 'code':
          lines.push('### ' + block.title, '');
          for (const snippet of block.snippets) lines.push('#### ' + snippet.label, '', '```' + snippet.language, snippet.code, '```', '');
          break;
        case 'table': {
          const cells = (values: string[]) => '| ' + values.map(value => value.replaceAll('|', '\\|').replaceAll('\n', ' ')).join(' | ') + ' |';
          lines.push(cells(block.headers), cells(block.headers.map(() => '---')), ...block.rows.map(cells), '');
          break;
        }
      }
    }
  }
  return lines.join('\n');
}
