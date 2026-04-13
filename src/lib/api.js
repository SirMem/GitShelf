// Fetch helpers for public data (manifest, toc, chapters, articles)

export async function fetchManifest() {
  const res = await fetch('./manifest.json');
  if (!res.ok) throw new Error(`Failed to load manifest: ${res.status}`);
  return res.json();
}

export async function fetchToc(bookId) {
  const res = await fetch(`./books/${bookId}/toc.json`);
  if (!res.ok) throw new Error(`Failed to load toc: ${res.status}`);
  return res.json();
}

export async function fetchText(url) {
  const res = await fetch(`./${url}`);
  if (!res.ok) throw new Error(`Failed to load ${url}: ${res.status}`);
  return res.text();
}

export function flattenChapters(items) {
  const result = [];
  for (const item of items) {
    if (item.slug && !item.anchor) result.push(item);
    if (item.children) result.push(...flattenChapters(item.children));
  }
  return result;
}

export function getItemDisplayTitle(item) {
  if (!item) return 'Untitled';
  const raw = String(item.title || item.display_title || item.id || 'Untitled');
  // Humanize filename-like titles (contain underscores or look like slugs)
  if (raw.includes('_') || /^[a-z0-9]+(-[a-z0-9]+)+$/.test(raw)) {
    return raw
      .replace(/[_-]/g, ' ')
      .replace(/\b[a-z]/g, (c) => c.toUpperCase());
  }
  return raw;
}

export function formatWordCount(count) {
  if (count >= 10000) return `${Math.round(count / 1000)}k`;
  if (count >= 1000) return `${(count / 1000).toFixed(1)}k`;
  return String(count);
}

export function getItemType(item) {
  return item?.type || 'book';
}

// Route helpers for each content type
export function getItemHref(item) {
  const type = getItemType(item);
  const encodedId = encodeURIComponent(item.id);
  if (type === 'book') return `#/books/${encodedId}`;
  if (type === 'doc') return `#/articles/${encodedId}`;
  if (type === 'site') return `./${item.entry}`;
  return `#/books/${encodedId}`;
}

export function getItemTarget(item) {
  return getItemType(item) === 'site' ? '_blank' : undefined;
}

export function formatRelativeDate(dateStr) {
  if (!dateStr) return '';
  const date = new Date(dateStr);
  const now = new Date();
  const diffMs = now - date;
  const diffH = Math.floor(diffMs / 3600000);
  if (diffH < 1) return 'Just now';
  if (diffH < 24) return `${diffH}h ago`;
  const diffDays = Math.floor(diffH / 24);
  if (diffDays === 1) return 'Yesterday';
  if (diffDays < 30) return `${diffDays}d ago`;
  if (diffDays < 365) return `${Math.floor(diffDays / 30)}mo ago`;
  return `${Math.floor(diffDays / 365)}y ago`;
}
