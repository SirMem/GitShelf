/**
 * GitHub API layer for GitShelf CLI.
 * Pure Node.js — no external dependencies.
 */

const https = require('node:https');
const { URL } = require('node:url');

const GITHUB_API_BASE = 'https://api.github.com';
const BRANCH = 'main';

const CATALOG_DEFAULT_PATH = 'docs/catalog.json';
const CATALOG_METADATA_PATH = 'docs/catalog-metadata.json';
const MANIFEST_PATH = 'docs/manifest.json';
const FAILURES_PATH = 'docs/failures.json';

const CONTENT_TYPE_DIRS = { book: 'docs/books', doc: 'docs/articles', site: 'docs/sites' };
const VISIBILITY_VALUES = ['published', 'hidden', 'archived'];
const MAX_FILE_SIZE = 100 * 1024 * 1024;
const ACCEPTED_EXTENSIONS = ['pdf', 'epub', 'md', 'zip'];

let catalogSourcePath = CATALOG_DEFAULT_PATH;

// --- HTTP ---

function request(url, { method = 'GET', body, token } = {}) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url.startsWith('http') ? url : `${GITHUB_API_BASE}${url}`);
    if (parsed.hostname !== 'api.github.com') {
      return reject(new Error('Requests only allowed to api.github.com'));
    }
    const headers = {
      'User-Agent': 'gitshelf-cli',
      Accept: 'application/vnd.github.v3+json',
      'Content-Type': 'application/json',
    };
    if (token) headers.Authorization = `Bearer ${token}`;

    const payload = body ? JSON.stringify(body) : null;
    const opts = { method, headers, hostname: parsed.hostname, path: parsed.pathname + parsed.search };
    if (payload) headers['Content-Length'] = Buffer.byteLength(payload);

    const req = https.request(opts, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString();
        if (res.statusCode === 204) return resolve(null);
        if (res.statusCode >= 400) {
          if (res.statusCode === 404) return reject(new Error(`404 Not Found: ${parsed.pathname}`));
          if (res.statusCode === 401) return reject(new Error('Authentication failed. Check your token.'));
          return reject(new Error(`GitHub API ${res.statusCode}: ${text.slice(0, 200)}`));
        }
        resolve(text ? JSON.parse(text) : null);
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function api(path, opts = {}) {
  return request(path, opts);
}

// --- Helpers ---

function isNotFound(err) { return String(err?.message).includes('404'); }

function normalizeVisibility(v) {
  const c = String(v || '').trim().toLowerCase();
  return VISIBILITY_VALUES.includes(c) ? c : 'published';
}

function normalizeTags(value) {
  if (Array.isArray(value)) return value.map((t) => String(t || '').trim()).filter(Boolean);
  if (typeof value === 'string') return value.split(',').map((t) => t.trim()).filter(Boolean);
  return [];
}

function compareString(a, b) {
  return String(a || '').localeCompare(String(b || ''), undefined, { sensitivity: 'base', numeric: true });
}

function getDisplayTitle(item) {
  return String(item.display_title || '').trim() || item.title || item.id;
}

function normalizeItem(raw) {
  const m = raw && typeof raw === 'object' ? raw : {};
  const id = String(m.id || '').trim();
  if (!id) return null;
  const nullNum = (v) => { if (v == null || v === '') return null; const n = Number(v); return Number.isFinite(n) ? Math.trunc(n) : null; };
  return {
    id,
    type: String(m.type || 'book').trim(),
    title: String(m.title || id).trim(),
    display_title: String(m.display_title || '').trim(),
    author: String(m.author || '').trim(),
    summary: String(m.summary || '').trim(),
    tags: normalizeTags(m.tags),
    featured: Boolean(m.featured),
    manual_order: nullNum(m.manual_order),
    visibility: normalizeVisibility(m.visibility),
    chapters_count: nullNum(m.chapters_count),
    word_count: nullNum(m.word_count),
    created_at: String(m.created_at || '').trim() || null,
    updated_at: String(m.updated_at || m.created_at || '').trim() || null,
    source: String(m.source || '').trim() || null,
    entry: String(m.entry || '').trim() || null,
  };
}

function parseCatalog(payload) {
  const records = Array.isArray(payload?.items) ? payload.items : [];
  return records.map(normalizeItem).filter(Boolean);
}

// --- Repo JSON ---

async function readJson(repo, path, token) {
  const data = await api(`/repos/${repo}/contents/${path}`, { token });
  if (!data?.content) throw new Error(`No content at ${path}`);
  const decoded = Buffer.from(data.content, 'base64').toString('utf-8');
  return { path, sha: data.sha, data: JSON.parse(decoded) };
}

async function readFile(repo, path, token) {
  const data = await api(`/repos/${repo}/contents/${path}`, { token });
  if (!data?.content) throw new Error(`No content at ${path}`);
  return Buffer.from(data.content, 'base64').toString('utf-8');
}

async function commitOps(repo, message, operations, token) {
  const ops = [...new Map(operations.filter((o) => o?.path).map((o) => [o.path, o])).values()];
  if (!ops.length) return;

  const ref = await api(`/repos/${repo}/git/refs/heads/${BRANCH}`, { token });
  const parentSha = ref?.object?.sha;
  const parent = await api(`/repos/${repo}/git/commits/${parentSha}`, { token });
  const baseTree = parent?.tree?.sha;

  const tree = ops.map((o) =>
    o.delete
      ? { path: o.path, mode: '100644', type: 'blob', sha: null }
      : { path: o.path, mode: '100644', type: 'blob', content: o.content },
  );

  const newTree = await api(`/repos/${repo}/git/trees`, {
    method: 'POST', token, body: { base_tree: baseTree, tree },
  });
  const newCommit = await api(`/repos/${repo}/git/commits`, {
    method: 'POST', token, body: { message, tree: newTree.sha, parents: [parentSha] },
  });
  await api(`/repos/${repo}/git/refs/heads/${BRANCH}`, {
    method: 'PATCH', token, body: { sha: newCommit.sha, force: false },
  });
}

async function listRepoTree(repo, path, token) {
  try {
    const data = await api(`/repos/${repo}/contents/${path}`, { token });
    if (!Array.isArray(data)) return data?.type === 'file' ? [data] : [];

    const nested = await Promise.all(data.map(async (entry) => {
      if (entry.type === 'dir') return listRepoTree(repo, entry.path, token);
      return entry.type === 'file' ? [entry] : [];
    }));
    return nested.flat();
  } catch { return []; }
}

async function getCacheDeleteOps(repo, itemId, token) {
  let pdfMd5;
  let epubMd5;
  try {
    const f = await readJson(repo, `docs/books/${itemId}/meta.json`, token);
    pdfMd5 = f.data?.pdf_md5;
    epubMd5 = f.data?.epub_md5;
  } catch { /* skip */ }
  const ops = [];

  if (pdfMd5) {
    const cacheFiles = await listRepoTree(repo, 'cache/markdown', token);
    ops.push(...cacheFiles
      .filter((f) => f.name.startsWith(pdfMd5))
      .map((f) => ({ path: f.path, delete: true })));
  }

  if (epubMd5) {
    const cacheFiles = await listRepoTree(repo, 'cache/epub', token);
    ops.push(...cacheFiles
      .filter((f) => f.name.startsWith(epubMd5))
      .map((f) => ({ path: f.path, delete: true })));
  }

  return ops;
}

function isSameCatalogItem(left, right) {
  return left.id === right.id && String(left.type || 'book') === String(right.type || 'book');
}

// --- Public API ---

async function verifyToken(token) {
  return api('/user', { token });
}

async function fetchCatalog(repo, token) {
  try {
    const f = await readJson(repo, CATALOG_DEFAULT_PATH, token);
    catalogSourcePath = f.path;
    return { items: parseCatalog(f.data), sourcePath: f.path };
  } catch (e) {
    if (!isNotFound(e)) throw e;
  }
  try {
    const f = await readJson(repo, MANIFEST_PATH, token);
    catalogSourcePath = CATALOG_DEFAULT_PATH;
    return {
      items: parseCatalog(f.data).map((b) => ({ ...b, visibility: 'published' })),
      sourcePath: CATALOG_DEFAULT_PATH,
    };
  } catch (e) {
    if (!isNotFound(e)) throw e;
    catalogSourcePath = CATALOG_DEFAULT_PATH;
    return { items: [], sourcePath: CATALOG_DEFAULT_PATH };
  }
}

function buildPublicManifest(items) {
  const pub = items.filter((b) => normalizeVisibility(b.visibility) === 'published');
  pub.sort((a, b) => {
    if (Boolean(a.featured) !== Boolean(b.featured)) return a.featured ? -1 : 1;
    const mo = (a.manual_order ?? Infinity) - (b.manual_order ?? Infinity);
    if (mo !== 0) return mo;
    return compareString(getDisplayTitle(a), getDisplayTitle(b));
  });
  return {
    items: pub.map((b) => {
      const r = { id: b.id, type: b.type, title: getDisplayTitle(b), author: b.author || undefined, summary: b.summary || undefined, tags: b.tags, featured: b.featured, source: b.source, created_at: b.created_at, updated_at: b.updated_at };
      if (b.type === 'book') { r.chapters_count = b.chapters_count; r.word_count = b.word_count; }
      else if (b.type === 'doc') { r.word_count = b.word_count; }
      else if (b.type === 'site') { r.entry = b.entry; }
      return r;
    }),
  };
}

function serializeCatalog(items) {
  const sorted = items.slice().sort((a, b) => compareString(a.id, b.id));
  return {
    version: 1, updated_at: new Date().toISOString(),
    items: sorted.map((b) => ({
      id: b.id, type: b.type, title: b.title, display_title: b.display_title || '',
      author: b.author || '', summary: b.summary || '', tags: b.tags || [],
      featured: b.featured, manual_order: b.manual_order,
      visibility: normalizeVisibility(b.visibility), source: b.source || '',
      entry: b.entry || undefined, chapters_count: b.chapters_count, word_count: b.word_count,
      created_at: b.created_at, updated_at: b.updated_at,
    })),
  };
}

function serializeMetadata(items) {
  const sorted = items.slice().sort((a, b) => compareString(a.id, b.id));
  return {
    version: 1, updated_at: new Date().toISOString(),
    items: sorted.map((b) => ({
      id: b.id, type: b.type, display_title: b.display_title || '',
      author: b.author || '', summary: b.summary || '', tags: b.tags || [],
      featured: b.featured, manual_order: b.manual_order,
      visibility: normalizeVisibility(b.visibility),
      metadata_updated_at: b.updated_at || null, source: b.source || '',
    })),
  };
}

async function persistCatalog(repo, items, message, token, extraOps = []) {
  const catPath = catalogSourcePath || CATALOG_DEFAULT_PATH;
  const ops = [
    { path: CATALOG_METADATA_PATH, content: JSON.stringify(serializeMetadata(items), null, 2) + '\n' },
    { path: catPath, content: JSON.stringify(serializeCatalog(items), null, 2) + '\n' },
    { path: MANIFEST_PATH, content: JSON.stringify(buildPublicManifest(items), null, 2) + '\n' },
    ...extraOps,
  ];
  await commitOps(repo, message, ops, token);
}

async function uploadContent(filePath, fileBuffer, repo, token) {
  const fileName = require('node:path').basename(filePath);
  const ext = fileName.split('.').pop().toLowerCase();
  if (!ACCEPTED_EXTENSIONS.includes(ext)) throw new Error(`Unsupported: ${ext}. Accepted: ${ACCEPTED_EXTENSIONS.join(', ')}`);
  if (fileBuffer.length > MAX_FILE_SIZE) throw new Error(`File too large (max 100 MB)`);

  const repoPath = `input/${encodeURIComponent(fileName)}`;
  let sha;
  try {
    const existing = await api(`/repos/${repo}/contents/${repoPath}`, { token });
    sha = existing.sha;
  } catch { /* new file */ }

  const body = { message: `feat(pipeline): upload ${fileName}`, content: fileBuffer.toString('base64') };
  if (sha) body.sha = sha;
  await api(`/repos/${repo}/contents/${repoPath}`, { method: 'PUT', token, body });
  return { file: fileName, actionsUrl: `https://github.com/${repo}/actions` };
}

async function deleteItem(item, repo, catalog, token) {
  const type = item.type || 'book';
  const dir = CONTENT_TYPE_DIRS[type] || 'docs/books';
  const files = await listRepoTree(repo, `${dir}/${item.id}`, token);
  const cacheOps = type === 'book' ? await getCacheDeleteOps(repo, item.id, token) : [];
  const next = catalog.filter((entry) => !isSameCatalogItem(entry, item));
  const deleteOps = [...files.map((f) => ({ path: f.path, delete: true })), ...cacheOps];
  await persistCatalog(repo, next, `chore(admin): delete ${type} ${item.id}`, token, deleteOps);
  return next;
}

async function triggerReconvert(item, repo, token, { clearCache = false } = {}) {
  const filename = item.source;
  if (!filename) throw new Error('Missing source file metadata');

  if (clearCache) {
    const ops = await getCacheDeleteOps(repo, item.id, token);
    if (ops.length) await commitOps(repo, `chore(admin): clear cache for ${item.id}`, ops, token);
  }

  await api(`/repos/${repo}/actions/workflows/convert.yml/dispatches`, {
    method: 'POST', token, body: { ref: 'main', inputs: { filename } },
  });
}

async function fetchFailures(repo, token) {
  try {
    const f = await readJson(repo, FAILURES_PATH, token);
    return Array.isArray(f.data?.failures) ? f.data.failures : [];
  } catch (e) {
    if (isNotFound(e)) return [];
    throw e;
  }
}

async function dismissFailure(repo, filename, token) {
  const all = await fetchFailures(repo, token);
  const filtered = all.filter((f) => f.filename !== filename);
  const ops = [{ path: FAILURES_PATH, content: JSON.stringify({ failures: filtered }, null, 2) + '\n' }];
  try {
    await api(`/repos/${repo}/contents/input/${filename}`, { token });
    ops.push({ path: `input/${filename}`, delete: true });
  } catch { /* file may not exist */ }
  await commitOps(repo, `chore(admin): dismiss failure for ${filename}`, ops, token);
}

async function retryFailure(repo, filename, token) {
  await api(`/repos/${repo}/actions/workflows/convert.yml/dispatches`, {
    method: 'POST', token, body: { ref: 'main', inputs: { filename } },
  });
}

module.exports = {
  verifyToken, fetchCatalog, persistCatalog, uploadContent, deleteItem,
  triggerReconvert, fetchFailures, dismissFailure, retryFailure,
  normalizeItem, normalizeTags, normalizeVisibility, getDisplayTitle,
  readJson, readFile,
  VISIBILITY_VALUES, ACCEPTED_EXTENSIONS, MAX_FILE_SIZE,
};
