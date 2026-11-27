// docs/changelog.json, the one record of what changed in the API. The gateway
// reads it for 410 route_retired and Deprecation headers; the website shows it
// at /changelog, /changelog.json and /changelog.xml.
import document from '../../../docs/changelog.json' with { type: 'json' };

export type ChangeType = 'added' | 'changed' | 'deprecated' | 'removed' | 'fixed' | 'security';
export type Release = { version: string; date: string; title: string; changes: { type: ChangeType; text: string }[] };
// A route (path, as in the API contract) or a field of an answer (field, as Schema.path).
export type Deprecation = {
  method?: string; path?: string; field?: string; deprecated_in: string; deprecated_on: string; sunset_on?: string; replacement: string; note?: string;
};
export type Retired = { method?: string; path: string; match?: 'prefix'; retired_in: string; retired_on: string; replacement: string; note?: string };
export type Changelog = {
  title: string; description: string; policy: { notice_days: number; compatibility?: string };
  releases: Release[]; deprecations: Deprecation[]; retired: Retired[];
};

export const changelog = document as Changelog;
export const CHANGE_LABELS: Record<ChangeType, string> = {
  added: 'Added', changed: 'Changed', deprecated: 'Deprecated', removed: 'Removed', fixed: 'Fixed', security: 'Security',
};
export const releaseAnchor = (version: string) => 'v' + version;
export const routeLabel = (entry: { method?: string; path?: string; field?: string; match?: string }) => entry.field && !entry.path
  ? `Field ${entry.field}`
  : `${entry.method ? entry.method + ' ' : ''}${entry.path ?? ''}${entry.match === 'prefix' ? '/…' : ''}`;

const escape = (value: string) => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// An Atom feed with one entry per release, newest first.
export function changelogAtom(site = 'https://fetchx.ai') {
  const page = `${site}/changelog`;
  const updated = `${changelog.releases[0]?.date ?? '2026-11-19'}T00:00:00Z`;
  const entries = changelog.releases.map(release => {
    const content = '<ul>' + release.changes.map(change => `<li><strong>${CHANGE_LABELS[change.type]}:</strong> ${escape(change.text)}</li>`).join('') + '</ul>';
    return `<entry><id>${page}#${releaseAnchor(release.version)}</id><title>${escape(`${release.version}: ${release.title}`)}</title>`
      + `<updated>${release.date}T00:00:00Z</updated><link rel="alternate" type="text/html" href="${page}#${releaseAnchor(release.version)}"/>`
      + `<content type="html">${escape(content)}</content></entry>`;
  }).join('');
  return '<?xml version="1.0" encoding="utf-8"?>\n<feed xmlns="http://www.w3.org/2005/Atom">'
    + `<id>${page}</id><title>${escape(changelog.title)}</title><subtitle>${escape(changelog.description)}</subtitle>`
    + `<link rel="alternate" type="text/html" href="${page}"/><link rel="self" type="application/atom+xml" href="${site}/changelog.xml"/>`
    + `<updated>${updated}</updated><author><name>FetchX</name></author>${entries}</feed>\n`;
}
