import { useState, useEffect, useCallback, useRef } from 'preact/hooks';
import { showToast } from '../lib/toast';
import ConfirmDialog from './ConfirmDialog';
import {
  getPat, setPat, clearPat, verifyPat, detectRepo, saveRepo,
  fetchCatalog, persistCatalog, deepCloneItems,
  uploadContent as apiUploadContent, triggerReconvert, deleteItemPermanently,
  loadHistory, fetchFailures, dismissFailure, retryFailure,
  getDisplayTitle, normalizeVisibility,
  normalizeTags, parseTagsInput, formatBytes, dateFormatter, dateTimeFormatter,
  numberFormatter, ACCEPTED_EXTENSIONS, MAX_FILE_SIZE, VISIBILITY_VALUES, toIsoNow,
} from '../lib/github-api';

const CONTENT_TYPE_LABELS = {
  book: 'Book',
  doc: 'Document',
  site: 'Site',
};

function formatCompact(n) {
  if (n == null) return '\u2014';
  if (n >= 1000000) return (n / 1000000).toFixed(1).replace(/\.0$/, '') + 'M';
  if (n >= 10000) return Math.round(n / 1000) + 'k';
  if (n >= 1000) return (n / 1000).toFixed(1).replace(/\.0$/, '') + 'k';
  return String(n);
}

function timeAgo(dateStr) {
  if (!dateStr) return '';
  const now = Date.now();
  const then = new Date(dateStr).getTime();
  if (Number.isNaN(then)) return '';
  const diff = Math.max(0, now - then);
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months}mo ago`;
  return `${Math.floor(months / 12)}y ago`;
}

function ContentTypeIcon({ type }) {
  if (type === 'book') return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <path d="M4 19.5v-15A2.5 2.5 0 0 1 6.5 2H20v20H6.5a2.5 2.5 0 0 1 0-5H20" />
    </svg>
  );
  if (type === 'doc') return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <polyline points="14 2 14 8 20 8" />
      <line x1="16" y1="13" x2="8" y2="13" />
      <line x1="16" y1="17" x2="8" y2="17" />
    </svg>
  );
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <circle cx="12" cy="12" r="10" />
      <line x1="2" y1="12" x2="22" y2="12" />
      <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
    </svg>
  );
}

function getItemType(item) {
  return item?.type || 'book';
}

function getContentHref(item) {
  const itemId = encodeURIComponent(item.id);
  const type = getItemType(item);
  if (type === 'doc') return `#/articles/${itemId}`;
  if (type === 'site') return `#/sites/${itemId}`;
  return `#/books/${itemId}`;
}

function getContentTypeLabel(item) {
  return CONTENT_TYPE_LABELS[getItemType(item)] || 'Content';
}

// --- Auth View ---
function AuthView({ onAuthenticated }) {
  const [token, setToken] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!token.trim()) { setError('Enter a GitHub PAT with repo scope.'); return; }
    setLoading(true); setError('');
    try {
      setPat(token.trim());
      await verifyPat();
      onAuthenticated();
    } catch (err) {
      clearPat(); setError(err.message);
    } finally { setLoading(false); }
  };

  return (
    <div class="admin-auth">
      <h2>GitHub Authentication</h2>
      <p>Enter a Personal Access Token with <strong>repo</strong> scope.</p>
      <form onSubmit={handleSubmit}>
        <div class="admin-input-group">
          <input type="password" class="admin-pat-input" value={token} onInput={(e) => setToken(e.target.value)} placeholder="ghp_…" autocomplete="off" aria-label="GitHub Personal Access Token" />
          <button class="btn btn-primary" type="submit" disabled={loading}>
            {loading ? <><span class="spinner" /> Verifying…</> : 'Save Token'}
          </button>
        </div>
      </form>
      {error && <p class="admin-error">{error}</p>}
      <p><a class="admin-text-link" href="https://github.com/settings/tokens/new?scopes=repo&description=GitShelf%20Admin" target="_blank" rel="noopener noreferrer">Create a new token on GitHub</a></p>
    </div>
  );
}

// --- Upload Section ---
function UploadSection({ repo, disabled }) {
  const [progress, setProgress] = useState(null);
  const [error, setError] = useState('');
  const [dragOver, setDragOver] = useState(false);
  let dragCounter = 0;
  const acceptedExtensionsLabel = ACCEPTED_EXTENSIONS.map((ext) => `.${ext}`).join(',');
  const acceptedExtensionsText = ACCEPTED_EXTENSIONS.map((ext) => `.${ext}`).join(', ');

  const handleFile = async (file) => {
    if (!file || disabled) return;
    setError('');
    const ext = file.name.split('.').pop().toLowerCase();
    if (!ACCEPTED_EXTENSIONS.includes(ext)) {
      setError(`Only ${acceptedExtensionsText} files are accepted.`);
      return;
    }
    if (file.size > MAX_FILE_SIZE) { setError(`File too large (${formatBytes(file.size)}). Max 100 MB.`); return; }
    try {
      await apiUploadContent(file, repo, (stage, msg) => setProgress({ stage, msg }));
      setProgress({ stage: 'done', msg: 'uploaded', filename: file.name });
      showToast('Content uploaded successfully', 'success');
    } catch (err) { setError(err.message); setProgress({ stage: 'error', msg: 'Upload failed.' }); }
  };

  const toneMap = { reading: 'info', committing: 'info', done: 'success', error: 'error' };
  const actionsUrl = repo.owner && repo.name ? `https://github.com/${repo.owner}/${repo.name}/actions` : null;

  return (
    <section class="admin-upload">
      <h2>Upload Content</h2>
      {disabled ? (
        <div class="upload-dropzone upload-dropzone--disabled">
          <svg class="upload-dropzone-icon" width="48" height="48" viewBox="0 0 48 48" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="M32 32l-8-8-8 8M24 24v18M40.78 37.09A10 10 0 0 0 36 18h-2.52A16 16 0 1 0 8 32.29" />
          </svg>
          <div class="upload-dropzone-text">Configure repository first</div>
        </div>
      ) : (
        <div
          class={`upload-dropzone${dragOver ? ' upload-dropzone--dragover' : ''}`}
          role="button"
          tabIndex="0"
          aria-label="Upload content file"
          onClick={() => { const i = document.createElement('input'); i.type = 'file'; i.accept = acceptedExtensionsLabel; i.onchange = () => handleFile(i.files[0]); i.click(); }}
          onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.currentTarget.click(); }}}
          onDragEnter={(e) => { e.preventDefault(); dragCounter++; setDragOver(true); }}
          onDragOver={(e) => e.preventDefault()}
          onDragLeave={(e) => { e.preventDefault(); dragCounter--; if (dragCounter <= 0) { dragCounter = 0; setDragOver(false); }}}
          onDrop={(e) => { e.preventDefault(); dragCounter = 0; setDragOver(false); handleFile(e.dataTransfer?.files?.[0]); }}
        >
          <svg class="upload-dropzone-icon" width="48" height="48" viewBox="0 0 48 48" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="M32 32l-8-8-8 8M24 24v18M40.78 37.09A10 10 0 0 0 36 18h-2.52A16 16 0 1 0 8 32.29" />
          </svg>
          <div class="upload-dropzone-text">Drop PDF, EPUB, Markdown, or ZIP here or click to browse</div>
          <div class="upload-dropzone-hint">Maximum 100 MB</div>
        </div>
      )}
      {progress && progress.stage === 'done' && actionsUrl ? (
        <div class="upload-progress upload-progress--success">
          <strong>{progress.filename}</strong> uploaded. A GitHub Action is now converting it.{' '}
          <a class="upload-progress-link" href={actionsUrl} target="_blank" rel="noopener noreferrer">View conversion progress</a>
        </div>
      ) : progress ? (
        <div class={`upload-progress upload-progress--${toneMap[progress.stage] || 'info'}`}>{progress.msg}</div>
      ) : null}
      {error && <p class="admin-error">{error}</p>}
    </section>
  );
}

// --- Failures Section ---
function FailuresSection({ repo }) {
  const [failures, setFailures] = useState([]);
  const [loading, setLoading] = useState(true);
  const repoReady = Boolean(repo.owner && repo.name);

  const load = useCallback(async () => {
    if (!repoReady) return;
    setLoading(true);
    try { setFailures(await fetchFailures(repo)); }
    catch { setFailures([]); }
    finally { setLoading(false); }
  }, [repo, repoReady]);

  useEffect(() => { load(); }, [load]);

  // Listen for catalog updates (e.g. after upload triggers a new conversion)
  useEffect(() => {
    const handler = () => load();
    window.addEventListener('gitshelf:catalog-updated', handler);
    return () => window.removeEventListener('gitshelf:catalog-updated', handler);
  }, [load]);

  if (!repoReady) return null;

  if (loading) return (
    <section class="admin-failures">
      <h2>Failed Conversions</h2>
      <div class="admin-skeleton-failures">
        {Array.from({ length: 2 }, (_, i) => (
          <div key={i} class="admin-skeleton-failure-row">
            <div class="admin-skeleton-failure-info">
              <div class="skeleton admin-skeleton-failure-name" />
              <div class="skeleton admin-skeleton-failure-msg" />
            </div>
            <div class="skeleton admin-skeleton-actions" />
          </div>
        ))}
      </div>
    </section>
  );

  if (failures.length === 0) return null;

  const handleRetry = async (filename) => {
    try {
      await retryFailure(repo, filename);
      showToast('Re-conversion triggered', 'info');
    } catch (err) { showToast(err.message, 'error'); }
  };

  const handleDismiss = async (filename) => {
    try {
      await dismissFailure(repo, filename);
      setFailures((prev) => prev.filter((f) => f.filename !== filename));
      showToast('Failure dismissed', 'success');
    } catch (err) { showToast(err.message, 'error'); }
  };

  return (
    <section class="admin-failures">
      <h2>Failed Conversions</h2>
      <div class="admin-failures-list">
        {failures.map((f) => (
          <div key={f.filename} class="admin-failure-row">
            <div class="admin-failure-info">
              <span class="admin-failure-filename">{f.filename}</span>
              <span class="admin-failure-error">{f.error}</span>
              {f.failed_at && <span class="admin-book-subtle">{dateTimeFormatter.format(new Date(f.failed_at))}</span>}
            </div>
            <div class="admin-actions">
              <button class="btn btn-secondary btn-sm" onClick={() => handleRetry(f.filename)}>Retry</button>
              <button class="btn btn-ghost-danger btn-sm" onClick={() => handleDismiss(f.filename)}>Dismiss</button>
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

// --- Book Editor ---
function BookEditor({ book, onSave, onCancel }) {
  const [form, setForm] = useState({
    display_title: book.display_title || '',
    author: book.author || '',
    summary: book.summary || '',
    tags: (book.tags || []).join(', '),
    manual_order: book.manual_order != null ? String(book.manual_order) : '',
    visibility: normalizeVisibility(book.visibility),
    featured: Boolean(book.featured),
  });
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  const set = (key) => (e) => setForm((f) => ({ ...f, [key]: e.target.type === 'checkbox' ? e.target.checked : e.target.value }));

  const handleSave = async () => {
    setError('');
    const mo = form.manual_order.trim();
    if (mo !== '' && (!Number.isInteger(Number(mo)) || Number(mo) < 0)) {
      setError('Manual order must be a whole number >= 0.'); return;
    }
    setSaving(true);
    try {
      await onSave({
        ...book,
        display_title: form.display_title.trim(),
        author: form.author.trim(),
        summary: form.summary.trim(),
        tags: parseTagsInput(form.tags),
        manual_order: mo === '' ? null : Math.trunc(Number(mo)),
        visibility: form.visibility,
        featured: form.featured,
        updated_at: toIsoNow(),
      });
    } catch (err) { setError(err.message); }
    finally { setSaving(false); }
  };

  return (
    <div class="admin-book-editor">
      <div class="admin-book-editor-grid">
        <label class="admin-input-stack">
          <span class="admin-label">Display Title</span>
          <input class="admin-text-input" value={form.display_title} onInput={set('display_title')} autocomplete="off" />
        </label>
        <label class="admin-input-stack">
          <span class="admin-label">Author</span>
          <input class="admin-text-input" value={form.author} onInput={set('author')} autocomplete="off" />
        </label>
        <label class="admin-input-stack" style={{ gridColumn: '1 / -1' }}>
          <span class="admin-label">Summary</span>
          <textarea class="admin-textarea" rows="3" value={form.summary} onInput={set('summary')} />
        </label>
        <label class="admin-input-stack">
          <span class="admin-label">Tags (comma-separated)</span>
          <input class="admin-text-input" value={form.tags} onInput={set('tags')} autocomplete="off" />
        </label>
        <label class="admin-input-stack">
          <span class="admin-label">Manual Order</span>
          <input class="admin-text-input" type="number" min="0" step="1" value={form.manual_order} onInput={set('manual_order')} />
        </label>
        <label class="admin-input-stack">
          <span class="admin-label">Visibility</span>
          <select class="admin-select" value={form.visibility} onChange={set('visibility')}>
            {VISIBILITY_VALUES.map((v) => <option key={v} value={v}>{v}</option>)}
          </select>
        </label>
        <div class="admin-input-stack">
          <label class="admin-checkbox-line">
            <input type="checkbox" class="admin-checkbox" checked={form.featured} onChange={set('featured')} />
            Featured
          </label>
        </div>
      </div>
      {error && <p class="admin-error">{error}</p>}
      <div class="admin-book-editor-actions">
        <button class="btn btn-primary btn-sm" type="button" onClick={handleSave} disabled={saving}>
          {saving ? <><span class="spinner" /> Saving…</> : 'Save'}
        </button>
        <button class="btn btn-secondary btn-sm" type="button" onClick={onCancel}>Cancel</button>
      </div>
    </div>
  );
}

// --- Action Menu (overflow dropdown) ---
function ActionMenu({ items }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);

  useEffect(() => {
    if (!open) return;
    const handler = (e) => { if (!ref.current?.contains(e.target)) setOpen(false); };
    document.addEventListener('pointerdown', handler);
    return () => document.removeEventListener('pointerdown', handler);
  }, [open]);

  return (
    <div class="action-menu" ref={ref}>
      <button class="btn btn-secondary btn-sm btn-icon" onClick={() => setOpen(!open)} aria-label="More actions" title="More actions">
        <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
          <circle cx="8" cy="3" r="1.5" /><circle cx="8" cy="8" r="1.5" /><circle cx="8" cy="13" r="1.5" />
        </svg>
      </button>
      {open && (
        <div class="action-menu-dropdown">
          {items.map((item, i) =>
            item.separator
              ? <div key={i} class="action-menu-divider" />
              : <button key={i} class={`action-menu-item${item.danger ? ' action-menu-item--danger' : ''}`} onClick={() => { setOpen(false); item.onClick(); }}>
                  {item.label}
                </button>
          )}
        </div>
      )}
    </div>
  );
}

// --- Catalog Section ---
function CatalogSection({ repo }) {
  const [catalog, setCatalog] = useState([]);
  const [notice, setNotice] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [search, setSearch] = useState('');
  const [visFilter, setVisFilter] = useState('all');
  const [sort, setSort] = useState('public_order');
  const [selected, setSelected] = useState(new Set());
  const [editingId, setEditingId] = useState(null);
  const [bulkError, setBulkError] = useState('');
  const [deleteTarget, setDeleteTarget] = useState(null);
  const [deleting, setDeleting] = useState(false);

  const repoReady = Boolean(repo.owner && repo.name);

  const load = useCallback(async () => {
    if (!repoReady) return;
    setLoading(true); setError('');
    try {
      const result = await fetchCatalog(repo);
      setCatalog(result.items); setNotice(result.notice);
    } catch (err) { setError(err.message); }
    finally { setLoading(false); }
  }, [repo, repoReady]);

  useEffect(() => { load(); }, [load]);

  const filtered = catalog.filter((b) => {
    if (visFilter !== 'all' && normalizeVisibility(b.visibility) !== visFilter) return false;
    if (search) {
      const q = search.toLowerCase();
      return [b.id, b.title, b.display_title, b.author, b.summary, b.source, b.entry, ...(b.tags || [])].some((f) => String(f || '').toLowerCase().includes(q));
    }
    return true;
  }).sort((a, b) => {
    if (sort === 'updated_desc') return (b.updated_at || '').localeCompare(a.updated_at || '');
    if (sort === 'created_desc') return (b.created_at || '').localeCompare(a.created_at || '');
    if (sort === 'title_asc') return getDisplayTitle(a).localeCompare(getDisplayTitle(b));
    if (sort === 'words_desc') return (b.word_count || 0) - (a.word_count || 0);
    return 0; // public_order — default
  });

  const toggleSelect = (id) => setSelected((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });
  const toggleAll = () => setSelected((s) => s.size === filtered.length ? new Set() : new Set(filtered.map((b) => b.id)));

  const bulkVisibility = async (vis) => {
    if (selected.size === 0) { setBulkError('Select at least one item.'); return; }
    setBulkError('');
    const next = deepCloneItems(catalog).map((b) => selected.has(b.id) ? { ...b, visibility: vis, updated_at: toIsoNow() } : b);
    try {
      await persistCatalog(repo, next, `chore(admin): bulk set visibility=${vis} (${selected.size} items)`);
      setCatalog(next); setSelected(new Set());
      showToast(`${selected.size} item${selected.size > 1 ? 's' : ''} set to ${vis}`, 'success');
    } catch (err) { setBulkError(err.message); }
  };

  const handleSaveItem = async (updated) => {
    const next = deepCloneItems(catalog).map((b) => b.id === updated.id ? updated : b);
    await persistCatalog(repo, next, `chore(admin): update catalog metadata for ${updated.id}`);
    setCatalog(next); setEditingId(null);
    showToast('Metadata saved', 'success');
  };

  const handleReprocess = async (item) => {
    await triggerReconvert(item, repo);
    showToast('Re-processing triggered', 'info');
  };

  const confirmDelete = async () => {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      const next = await deleteItemPermanently(deleteTarget, repo, catalog);
      setCatalog(next); setSelected((s) => { const n = new Set(s); n.delete(deleteTarget.id); return n; });
      setEditingId(null);
      setDeleteTarget(null);
      showToast(`${getContentTypeLabel(deleteTarget)} deleted permanently`, 'success');
    } catch (err) { showToast(err.message, 'error'); }
    finally { setDeleting(false); }
  };

  const quickVisibilityChange = async (item, targetVis) => {
    const cycle = { published: 'hidden', hidden: 'archived', archived: 'published' };
    const nextVis = targetVis || cycle[normalizeVisibility(item.visibility)];
    const next = deepCloneItems(catalog).map((b) => b.id === item.id ? { ...b, visibility: nextVis, updated_at: toIsoNow() } : b);
    try {
      await persistCatalog(repo, next, `chore(admin): set visibility=${nextVis} for ${item.id}`);
      setCatalog(next);
      showToast(`"${getDisplayTitle(item)}" set to ${nextVis}`, 'success');
    } catch (err) { showToast(err.message, 'error'); }
  };

  const counts = { total: catalog.length, published: 0, hidden: 0, archived: 0 };
  catalog.forEach((b) => { const v = normalizeVisibility(b.visibility); if (counts[v] != null) counts[v]++; });

  if (!repoReady) return <section class="admin-books"><h2>Content Catalog</h2><div class="admin-empty-state">Configure repository to view catalog.</div></section>;
  if (loading) return (
    <section class="admin-books">
      <h2>Content Catalog</h2>
      <div class="admin-skeleton-table">
        {Array.from({ length: 5 }, (_, i) => (
          <div key={i} class="admin-skeleton-row">
            <div class="skeleton admin-skeleton-check" />
            <div class="skeleton admin-skeleton-title" />
            <div class="skeleton admin-skeleton-pill" />
            <div class="skeleton admin-skeleton-text" />
            <div class="skeleton admin-skeleton-text admin-skeleton-text--short" />
            <div class="skeleton admin-skeleton-actions" />
          </div>
        ))}
      </div>
    </section>
  );
  if (error) return <section class="admin-books"><h2>Content Catalog</h2><p class="admin-error">{error}</p></section>;

  return (
    <section class="admin-books">
      <h2>Content Catalog</h2>
      {notice && <div class="admin-repo-banner">{notice}</div>}

      <div class="admin-summary-pills" role="group" aria-label="Filter by visibility">
        <button class={`admin-summary-pill${visFilter === 'all' ? ' admin-summary-pill--active' : ''}`} onClick={() => setVisFilter('all')} aria-pressed={visFilter === 'all'}>
          <span class="admin-summary-pill-count">{counts.total}</span>
          <span class="admin-summary-pill-label">Total</span>
        </button>
        <button class={`admin-summary-pill admin-summary-pill--published${visFilter === 'published' ? ' admin-summary-pill--active' : ''}`} onClick={() => setVisFilter('published')} aria-pressed={visFilter === 'published'}>
          <span class="admin-summary-pill-count">{counts.published}</span>
          <span class="admin-summary-pill-label">Published</span>
        </button>
        <button class={`admin-summary-pill admin-summary-pill--hidden${visFilter === 'hidden' ? ' admin-summary-pill--active' : ''}`} onClick={() => setVisFilter('hidden')} aria-pressed={visFilter === 'hidden'}>
          <span class="admin-summary-pill-count">{counts.hidden}</span>
          <span class="admin-summary-pill-label">Hidden</span>
        </button>
        <button class={`admin-summary-pill admin-summary-pill--archived${visFilter === 'archived' ? ' admin-summary-pill--active' : ''}`} onClick={() => setVisFilter('archived')} aria-pressed={visFilter === 'archived'}>
          <span class="admin-summary-pill-count">{counts.archived}</span>
          <span class="admin-summary-pill-label">Archived</span>
        </button>
      </div>

      <div class="admin-catalog-toolbar">
        <div class="admin-search-wrap">
          <svg class="admin-search-icon" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true">
            <circle cx="11" cy="11" r="8" /><line x1="21" y1="21" x2="16.65" y2="16.65" />
          </svg>
          <input type="search" class="admin-text-input admin-search-input" placeholder="Search content…" value={search} onInput={(e) => setSearch(e.target.value)} aria-label="Search content" />
        </div>
        <select class="admin-select" value={sort} onChange={(e) => setSort(e.target.value)} aria-label="Sort order">
          <option value="public_order">Featured + Manual Order</option>
          <option value="updated_desc">Recently Updated</option>
          <option value="created_desc">Recently Created</option>
          <option value="title_asc">Title A-Z</option>
          <option value="words_desc">Word Count</option>
        </select>
        <button class="btn btn-secondary btn-icon" type="button" onClick={load} aria-label="Refresh catalog" title="Refresh">
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="M1.5 8a6.5 6.5 0 0 1 11.25-4.5M14.5 8a6.5 6.5 0 0 1-11.25 4.5" />
            <path d="M13.5 1v3.5H10M2.5 15v-3.5H6" />
          </svg>
        </button>
      </div>

      {(search || visFilter !== 'all') && (
        <p class="admin-result-count">Showing {filtered.length} of {catalog.length} item{catalog.length !== 1 ? 's' : ''}</p>
      )}

      {selected.size > 0 && (
        <div class="admin-bulk-bar">
          <span>{selected.size} selected</span>
          <button class="btn btn-secondary" onClick={() => bulkVisibility('published')}>Publish</button>
          <button class="btn btn-secondary" onClick={() => bulkVisibility('hidden')}>Hide</button>
          <button class="btn btn-secondary" onClick={() => bulkVisibility('archived')}>Archive</button>
          <button class="btn btn-secondary" onClick={() => setSelected(new Set())}>Clear</button>
        </div>
      )}
      {bulkError && <p class="admin-error">{bulkError}</p>}

      {filtered.length === 0 ? (
        <div class="admin-empty-state">
          {catalog.length === 0 ? (
            <>
              <svg class="admin-empty-icon" width="48" height="48" viewBox="0 0 48 48" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <path d="M8 6h10a4 4 0 0 1 4 4v28a3 3 0 0 0-3-3H8V6zM40 6H30a4 4 0 0 0-4 4v28a3 3 0 0 1 3-3h11V6z" />
              </svg>
              <p class="admin-empty-text">No content yet. Upload a PDF, EPUB, Markdown file, or ZIP to get started.</p>
            </>
          ) : (
            <>
              <svg class="admin-empty-icon" width="48" height="48" viewBox="0 0 48 48" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <circle cx="20" cy="20" r="14" /><path d="M38 38l-8-8" />
              </svg>
              <p class="admin-empty-text">No content matches the current filters.</p>
            </>
          )}
        </div>
      ) : (
        <>
          {/* Desktop grid table */}
          <div class="admin-catalog-grid">
            <div class="admin-catalog-grid-head">
              <div class="admin-grid-cell admin-grid-cell--check"><input type="checkbox" class="admin-checkbox" checked={selected.size === filtered.length && filtered.length > 0} indeterminate={selected.size > 0 && selected.size < filtered.length} onChange={toggleAll} aria-label="Select all items" /></div>
              <div class="admin-grid-cell">Title</div>
              <div class="admin-grid-cell">Status</div>
              <div class="admin-grid-cell">Source</div>
              <div class="admin-grid-cell admin-grid-cell--right">Stats</div>
              <div class="admin-grid-cell admin-grid-cell--right"></div>
            </div>
            {filtered.map((item) => (
              <div key={item.id}>
                <div class="admin-catalog-grid-row">
                  <div class="admin-grid-cell admin-grid-cell--check"><input type="checkbox" class="admin-checkbox" checked={selected.has(item.id)} onChange={() => toggleSelect(item.id)} aria-label={`Select ${getDisplayTitle(item)}`} /></div>
                  <div class="admin-grid-cell admin-grid-cell--title">
                    <span class={`admin-type-icon admin-type-icon--${getItemType(item)}`}><ContentTypeIcon type={getItemType(item)} /></span>
                    <div class="admin-book-title-wrap">
                      <a class="admin-book-title-link" href={getContentHref(item)}>{getDisplayTitle(item)}</a>
                      <div class="admin-title-meta">
                        <span class="admin-book-subtle">{getContentTypeLabel(item)}</span>
                        <span class="admin-title-sep" aria-hidden="true">&middot;</span>
                        <span class="admin-id-mono">{item.id}</span>
                      </div>
                      {item.tags && item.tags.length > 0 && (
                        <div class="admin-tag-list">
                          {item.tags.slice(0, 4).map((t) => <span key={t} class="admin-tag">{t}</span>)}
                          {item.tags.length > 4 && <span class="admin-tag">+{item.tags.length - 4}</span>}
                        </div>
                      )}
                    </div>
                  </div>
                  <div class="admin-grid-cell admin-grid-cell--status">
                    <span class={`admin-status-dot admin-status-dot--${normalizeVisibility(item.visibility)}`} />
                    <span class="admin-status-label">{normalizeVisibility(item.visibility)}</span>
                  </div>
                  <div class="admin-grid-cell admin-grid-cell--source">
                    <span class="admin-source-file">{item.source || '\u2014'}</span>
                    <span class="admin-source-time">{timeAgo(item.updated_at) || '\u2014'}</span>
                  </div>
                  <div class="admin-grid-cell admin-grid-cell--stats">
                    <span class="admin-stat-value">{formatCompact(item.chapters_count)}</span>
                    <span class="admin-stat-unit">ch.</span>
                    <span class="admin-stat-divider" aria-hidden="true" />
                    <span class="admin-stat-value">{formatCompact(item.word_count)}</span>
                    <span class="admin-stat-unit">words</span>
                  </div>
                  <div class="admin-grid-cell admin-grid-cell--actions">
                    <ActionMenu items={[
                      { label: 'Edit', onClick: () => setEditingId(editingId === item.id ? null : item.id) },
                      ...(getItemType(item) === 'book' ? [{ label: 'Re-process', onClick: () => handleReprocess(item) }] : []),
                      { separator: true },
                      { label: 'Publish', onClick: () => quickVisibilityChange(item, 'published'), hidden: normalizeVisibility(item.visibility) === 'published' },
                      { label: 'Hide', onClick: () => quickVisibilityChange(item, 'hidden'), hidden: normalizeVisibility(item.visibility) === 'hidden' },
                      { label: 'Archive', onClick: () => quickVisibilityChange(item, 'archived'), hidden: normalizeVisibility(item.visibility) === 'archived' },
                      { separator: true },
                      { label: 'Force Delete', danger: true, onClick: () => setDeleteTarget(item) },
                    ].filter((i) => !i.hidden)} />
                  </div>
                </div>
                {editingId === item.id && (
                  <div class="admin-catalog-grid-editor"><BookEditor book={item} onSave={handleSaveItem} onCancel={() => setEditingId(null)} /></div>
                )}
              </div>
            ))}
          </div>

          {/* Mobile cards */}
          <div class="admin-catalog-cards">
            {filtered.map((item) => (
              <div key={item.id} class="admin-catalog-card">
                <div class="admin-catalog-card-header">
                  <input type="checkbox" class="admin-checkbox" checked={selected.has(item.id)} onChange={() => toggleSelect(item.id)} aria-label={`Select ${getDisplayTitle(item)}`} />
                  <span class={`admin-type-icon admin-type-icon--${getItemType(item)}`}><ContentTypeIcon type={getItemType(item)} /></span>
                  <a class="admin-book-title-link" href={getContentHref(item)}>{getDisplayTitle(item)}</a>
                  <span class="admin-card-status">
                    <span class={`admin-status-dot admin-status-dot--${normalizeVisibility(item.visibility)}`} />
                    <span class="admin-status-label">{normalizeVisibility(item.visibility)}</span>
                  </span>
                </div>
                <div class="admin-catalog-card-meta">
                  {item.source && <span class="admin-source-file">{item.source}</span>}
                  <span class="admin-book-subtle">
                    {[item.chapters_count != null && `${formatCompact(item.chapters_count)} ch`, item.word_count != null && `${formatCompact(item.word_count)} words`].filter(Boolean).join(' \u00b7 ')}
                  </span>
                  {item.updated_at && <span class="admin-book-subtle">{timeAgo(item.updated_at)}</span>}
                </div>
                <div class="admin-catalog-card-actions">
                  <ActionMenu items={[
                    { label: 'Edit', onClick: () => setEditingId(editingId === item.id ? null : item.id) },
                    ...(getItemType(item) === 'book' ? [{ label: 'Re-process', onClick: () => handleReprocess(item) }] : []),
                    { separator: true },
                    { label: 'Publish', onClick: () => quickVisibilityChange(item, 'published'), hidden: normalizeVisibility(item.visibility) === 'published' },
                    { label: 'Hide', onClick: () => quickVisibilityChange(item, 'hidden'), hidden: normalizeVisibility(item.visibility) === 'hidden' },
                    { label: 'Archive', onClick: () => quickVisibilityChange(item, 'archived'), hidden: normalizeVisibility(item.visibility) === 'archived' },
                    { separator: true },
                    { label: 'Force Delete', danger: true, onClick: () => setDeleteTarget(item) },
                  ].filter((i) => !i.hidden)} />
                </div>
                {editingId === item.id && (
                  <div class="admin-catalog-card-editor"><BookEditor book={item} onSave={handleSaveItem} onCancel={() => setEditingId(null)} /></div>
                )}
              </div>
            ))}
          </div>
        </>
      )}

      <ConfirmDialog
        open={Boolean(deleteTarget)}
        title="Force Delete"
        danger
        confirmLabel="Force Delete"
        typeConfirm={deleteTarget?.id}
        typeConfirmHint={`Type "${deleteTarget?.id}" to confirm`}
        busy={deleting}
        onConfirm={confirmDelete}
        onCancel={() => setDeleteTarget(null)}
      >
        <p>This will permanently delete <strong>{deleteTarget ? getDisplayTitle(deleteTarget) : ''}</strong> and all of its generated files. This action cannot be undone.</p>
      </ConfirmDialog>
    </section>
  );
}

// --- History Section ---
function HistorySection({ repo }) {
  const repoReady = Boolean(repo.owner && repo.name);
  const [items, setItems] = useState(null);
  useEffect(() => { if (repoReady) loadHistory(repo).then(setItems); }, [repo, repoReady]);
  return (
    <section class="admin-history">
      <h2>Conversion History</h2>
      {!repoReady ? (
        <div class="admin-empty-state">Configure repository to view history.</div>
      ) : items === null ? (
        <div class="admin-skeleton-history">
          {Array.from({ length: 3 }, (_, i) => (
            <div key={i} class="admin-skeleton-history-row">
              <div class="skeleton admin-skeleton-history-name" />
              <div class="skeleton admin-skeleton-history-size" />
            </div>
          ))}
        </div>
      ) : items.length === 0 ? (
        <div class="admin-empty-state">
          <p class="admin-empty-text">No archived PDFs yet. Source files appear here after a book is re-converted, keeping the original upload as a reference.</p>
        </div>
      ) : (
        <ul class="admin-history-items">
          {items.map((f) => <li key={f.name}><span class="history-name">{f.name}</span><span class="history-size">{formatBytes(f.size)}</span></li>)}
        </ul>
      )}
    </section>
  );
}

// --- Settings Section ---
function SettingsSection({ repo, onRepoChange }) {
  const [owner, setOwner] = useState(repo.owner);
  const [name, setName] = useState(repo.name);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [showClearPat, setShowClearPat] = useState(false);

  const handleSaveRepo = (e) => {
    e.preventDefault();
    if (!owner.trim() || !name.trim()) { setError('Enter both owner and name.'); return; }
    saveRepo(owner.trim(), name.trim());
    onRepoChange({ owner: owner.trim(), name: name.trim() });
    showToast('Repository saved', 'success');
  };


  return (
    <section class="admin-settings">
      <h2>Settings</h2>

      <div class="admin-setting-group">
        <h3 class="admin-subheading">Repository</h3>
        <form onSubmit={handleSaveRepo}>
          <div class="admin-form-grid" style={{ gridTemplateColumns: '1fr 1fr auto' }}>
            <label class="admin-input-stack"><span class="admin-label">Owner</span><input class="admin-text-input" value={owner} onInput={(e) => setOwner(e.target.value)} autocomplete="off" /></label>
            <label class="admin-input-stack"><span class="admin-label">Repository</span><input class="admin-text-input" value={name} onInput={(e) => setName(e.target.value)} autocomplete="off" /></label>
            <div class="admin-inline-actions"><button class="btn btn-primary" type="submit">Save</button></div>
          </div>
        </form>
      </div>

      <div class="admin-setting-group">
        <h3 class="admin-subheading">Authentication</h3>
        <div class="admin-actions">
          <button class="btn btn-secondary" onClick={() => { clearPat(); window.location.reload(); }}>Update PAT</button>
          <button class="btn btn-danger" onClick={() => setShowClearPat(true)}>Clear PAT</button>
        </div>
      </div>

      {error && <p class="admin-error">{error}</p>}

      <ConfirmDialog
        open={showClearPat}
        title="Clear Personal Access Token"
        danger
        confirmLabel="Clear Token"
        onConfirm={() => { clearPat(); window.location.reload(); }}
        onCancel={() => setShowClearPat(false)}
      >
        <p>Your GitHub PAT will be removed from local storage. You'll need to re-authenticate to use the admin panel.</p>
      </ConfirmDialog>
    </section>
  );
}

// --- Main Admin Panel ---
export default function AdminPanel() {
  const [authenticated, setAuthenticated] = useState(Boolean(getPat()));
  const [repo, setRepo] = useState(detectRepo);
  const repoReady = Boolean(repo.owner && repo.name);
  const [tab, setTab] = useState(repoReady ? 'content' : 'settings');
  const previousRepoReady = useRef(repoReady);

  useEffect(() => { document.title = 'Admin \u00b7 GitShelf'; }, []);

  useEffect(() => {
    if (repoReady && !previousRepoReady.current) {
      setTab('content');
    }
    previousRepoReady.current = repoReady;
  }, [repoReady]);

  if (!authenticated) {
    return (
      <div class="admin-panel view-enter">
        <h1 class="admin-page-title">Admin</h1>
        <AuthView onAuthenticated={() => setAuthenticated(true)} />
      </div>
    );
  }

  const handleRepoChange = (newRepo) => {
    setRepo(newRepo);
    if (newRepo.owner && newRepo.name) setTab('content');
  };

  return (
    <div class="admin-panel view-enter">
      <h1 class="admin-page-title">Admin</h1>
      {repoReady && (
        <div class="admin-repo-banner">{`Repository: ${repo.owner}/${repo.name}`}</div>
      )}
      <nav class="admin-tabs" role="tablist">
        <button
          class={`admin-tab${tab === 'content' ? ' admin-tab--active' : ''}`}
          role="tab"
          aria-selected={tab === 'content'}
          onClick={() => setTab('content')}
        >Content</button>
        <button
          class={`admin-tab${tab === 'settings' ? ' admin-tab--active' : ''}`}
          role="tab"
          aria-selected={tab === 'settings'}
          onClick={() => setTab('settings')}
        >Settings</button>
      </nav>

      {tab === 'content' && (
        <>
          {!repoReady && (
            <div class="admin-repo-banner admin-repo-banner--warning">
              Configure your repository in the <button class="admin-inline-link" onClick={() => setTab('settings')}>Settings</button> tab first.
            </div>
          )}
          <UploadSection repo={repo} disabled={!repoReady} />
          <FailuresSection repo={repo} />
          <CatalogSection repo={repo} />
        </>
      )}

      {tab === 'settings' && (
        <>
          <SettingsSection repo={repo} onRepoChange={handleRepoChange} />
          <HistorySection repo={repo} />
        </>
      )}
    </div>
  );
}
