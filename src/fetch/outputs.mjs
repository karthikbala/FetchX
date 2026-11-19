// Derived outputs requested with `formats`: markdown, text, links, metadata and
// json. They are computed once, from the final document, when the request
// finishes. The page is sanitised first: scripts, forms, frames and hidden
// content never reach the outputs, and every URL is made absolute.
import {load} from 'cheerio';
import TurndownService from 'turndown';
import {gfm} from 'turndown-plugin-gfm';

const INPUT_LIMIT = 5_000_000;
const OUTPUT_LIMIT = 5_000_000;
const MAX_LINKS = 2000;
const MAX_NODES = 100_000;
const DISCARDED = 'script,style,noscript,template,iframe,frame,object,embed,svg,math,canvas,form,button,input,select,'
  + 'textarea,audio,video,[hidden],[aria-hidden="true"]';
const KEPT_TAGS = new Set(('a abbr article b blockquote br caption cite code dd del details div dl dt em figcaption figure '
  + 'h1 h2 h3 h4 h5 h6 header hr i img kbd li main mark nav ol p pre s samp section small span strong sub summary sup '
  + 'table tbody td tfoot th thead tr u ul var footer aside').split(' '));
const BLOCKS = 'p,div,h1,h2,h3,h4,h5,h6,li,tr,section,article,header,footer,main,nav,aside,blockquote,pre,br,dt,dd,figcaption,caption,summary';
const KEPT_ATTRIBUTES = {
  a: ['href', 'title'], img: ['src', 'alt', 'title'], ol: ['start'], li: ['value'],
  th: ['colspan', 'rowspan', 'scope'], td: ['colspan', 'rowspan'],
};

const markdownService = new TurndownService({headingStyle: 'atx', bulletListMarker: '-', codeBlockStyle: 'fenced'}).use(gfm);
// GFM tables cannot hold merged cells or captions; keep those as HTML.
markdownService.addRule('complexTable', {
  filter: node => node.nodeName === 'TABLE' && (!node.rows.length || node.querySelector('caption,[colspan],[rowspan],table')),
  replacement: (_content, node) => '\n\n' + node.outerHTML + '\n\n',
});

function absolute(value, base) {
  if (!value || value.length > 2048) return undefined;
  try {
    const url = new URL(value, base);
    if (['http:', 'https:'].includes(url.protocol) && !url.username && !url.password) return url.href;
  } catch { /* not a URL */ }
  return undefined;
}

const clean = value => value?.replace(/\s+/gu, ' ').trim().slice(0, 2048) || undefined;
const capped = text => (Buffer.byteLength(text) > OUTPUT_LIMIT ? text.slice(0, OUTPUT_LIMIT) : text);

function metadataOf($, {finalUrl, headers}) {
  const meta = selector => clean($(selector).first().attr('content'));
  const openGraph = {};
  $('head meta[property^="og:"]').slice(0, 50).each((_, node) => {
    const key = node.attribs.property.slice(3);
    if (/^[a-z_:]{1,40}$/.test(key) && !openGraph[key]) openGraph[key] = clean(node.attribs.content);
  });
  const canonical = absolute($('head link[rel="canonical"]').first().attr('href'), finalUrl);
  return Object.fromEntries(Object.entries({
    title: clean($('head title').first().text()) ?? openGraph.title,
    description: meta('head meta[name="description" i]') ?? openGraph.description,
    canonical_url: canonical,
    language: clean($('html').attr('lang')) ?? clean(headers?.['content-language']),
    open_graph: Object.keys(openGraph).length ? openGraph : undefined,
  }).filter(([, value]) => value !== undefined));
}

function sanitise($, base) {
  $(DISCARDED).remove();
  $('*').contents().filter((_, node) => node.type === 'comment').remove();
  const body = $('body');
  let count = 0;
  for (const node of body.find('*').toArray().reverse()) {
    if (++count > MAX_NODES) break;
    const element = $(node);
    if (!KEPT_TAGS.has(node.name)) {
      element.replaceWith(element.contents());
      continue;
    }
    const attributes = {};
    for (const name of KEPT_ATTRIBUTES[node.name] ?? []) {
      let value = node.attribs[name];
      if (value === undefined) continue;
      if (name === 'href' || name === 'src') value = absolute(value, base);
      else value = value.slice(0, 2048);
      if (value !== undefined) attributes[name] = value;
    }
    node.attribs = attributes;
  }
  return body;
}

const isHtml = contentType => /\b(?:text\/html|application\/xhtml\+xml)\b/i.test(contentType ?? '');
const isJson = contentType => /\bjson\b/i.test(contentType ?? '');

// body: Buffer of the final document; formats: requested outputs.
export function deriveOutputs({body, contentType, finalUrl, headers}, formats) {
  const wanted = formats.filter(format => format !== 'screenshot');
  if (!wanted.length || !body) return {};
  const out = {};
  const text = body.subarray(0, INPUT_LIMIT).toString('utf8');
  if (wanted.includes('json')) {
    if (isJson(contentType)) {
      try { out.json = JSON.parse(body.toString('utf8')); } catch { out.json = null; }
    } else out.json = null;
  }
  const htmlFormats = wanted.filter(format => format !== 'json');
  if (!htmlFormats.length) return out;
  if (!isHtml(contentType)) {
    // Plain text is its own text and markdown; other types have none.
    const plain = /^text\//i.test(contentType ?? '') ? capped(text) : null;
    for (const format of htmlFormats) out[format] = format === 'links' ? [] : format === 'metadata' ? {} : plain;
    return out;
  }
  const $ = load(text);
  if (htmlFormats.includes('metadata')) out.metadata = metadataOf($, {finalUrl, headers});
  const region = sanitise($, finalUrl);
  if (htmlFormats.includes('links')) {
    out.links = [...new Set(region.find('a[href]').toArray().map(node => node.attribs.href).filter(Boolean))]
      .slice(0, MAX_LINKS)
      .map(url => ({url, text: clean(region.find(`a[href="${url.replace(/"/g, '\\"')}"]`).first().text()) ?? ''}));
  }
  if (htmlFormats.includes('markdown')) out.markdown = capped(markdownService.turndown(region.html() ?? ''));
  if (htmlFormats.includes('text')) {
    // Block elements end a line of text; without this, headings run into paragraphs.
    region.find(BLOCKS).each((_, node) => { $(node).append('\n'); });
    out.text = capped(region.text().replace(/[ \t\f\v\u00a0]+/gu, ' ').replace(/\s*\n\s*/g, '\n').trim());
  }
  return out;
}
