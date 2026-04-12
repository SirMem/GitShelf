#!/usr/bin/env node

/**
 * GitShelf MCP Server
 *
 * GitShelf is a zero-cost GitHub Pages content platform. Upload PDFs or
 * EPUBs (auto-converted to chapter books), Markdown (rendered as
 * documents), or ZIP archives (deployed as static sites). Everything is
 * processed by GitHub Actions and served from GitHub Pages.
 *
 * This MCP server exposes GitShelf content reading and management tools.
 *
 * Config (same as CLI):
 *   GITSHELF_TOKEN   GitHub Personal Access Token
 *   GITSHELF_REPO    Target repository (owner/name)
 *   .gitshelfrc      Optional JSON config in current directory
 *   ~/.config/gitshelf/config.json  Global config
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';

const require = createRequire(import.meta.url);
const github = require('./github.js');
const { loadConfig } = require('./util.js');

// --- Config ---

function getConfig() {
  return loadConfig([]);
}

// --- Server ---

const server = new McpServer(
  {
    name: 'gitshelf',
    version: '0.1.3',
  },
  {
    instructions: 'GitShelf is a zero-cost GitHub Pages content platform. Upload PDFs or EPUBs (auto-converted to multi-chapter books with TOC and reader UI), Markdown files (rendered as documents), or ZIP archives (deployed as static sites). Everything is processed by GitHub Actions and served from GitHub Pages. Use these tools to browse, read, and manage GitShelf content.',
  },
);

// --- Tools: Read ---

server.registerTool(
  'list_items',
  {
    title: 'List Items',
    description: 'List all content items in the GitShelf repository. Optionally filter by type (book, doc, site).',
    inputSchema: z.object({
      type: z.enum(['book', 'doc', 'site']).optional().describe('Filter by content type'),
    }),
  },
  async ({ type }) => {
    const { token, repo } = getConfig();
    const { items } = await github.fetchCatalog(repo, token);
    const filtered = type ? items.filter((i) => i.type === type) : items;
    const summary = filtered.map((i) => ({
      id: i.id,
      type: i.type,
      title: github.getDisplayTitle(i),
      visibility: i.visibility,
      tags: i.tags,
      word_count: i.word_count,
      chapters_count: i.chapters_count,
      created_at: i.created_at,
    }));
    return { content: [{ type: 'text', text: JSON.stringify(summary, null, 2) }] };
  },
);

server.registerTool(
  'get_item',
  {
    title: 'Get Item Details',
    description: 'Get full metadata for a single content item by its ID.',
    inputSchema: z.object({
      id: z.string().describe('Item ID (e.g. "progit") or type:id selector (e.g. "book:progit")'),
    }),
  },
  async ({ id }) => {
    const { token, repo } = getConfig();
    const { items } = await github.fetchCatalog(repo, token);

    const { type: typeHint, id: itemId } = parseSelector(id);
    const item = findItem(items, itemId, typeHint);
    return { content: [{ type: 'text', text: JSON.stringify(item, null, 2) }] };
  },
);

server.registerTool(
  'get_toc',
  {
    title: 'Get Book Table of Contents',
    description: 'Get the table of contents (chapter hierarchy) for a book. Returns chapter titles and slugs.',
    inputSchema: z.object({
      book_id: z.string().describe('Book ID (e.g. "progit")'),
    }),
  },
  async ({ book_id }) => {
    const { token, repo } = getConfig();
    const { data } = await github.readJson(repo, `docs/books/${book_id}/toc.json`, token);
    return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
  },
);

server.registerTool(
  'read_chapter',
  {
    title: 'Read Book Chapter',
    description: 'Read the markdown content of a specific book chapter. Use get_toc first to find available slugs.',
    inputSchema: z.object({
      book_id: z.string().describe('Book ID (e.g. "progit")'),
      slug: z.string().describe('Chapter slug from toc.json (e.g. "01-pro-git")'),
    }),
  },
  async ({ book_id, slug }) => {
    const { token, repo } = getConfig();
    const content = await github.readFile(repo, `docs/books/${book_id}/chapters/${slug}.md`, token);
    return { content: [{ type: 'text', text: content }] };
  },
);

server.registerTool(
  'get_url',
  {
    title: 'Get Item URL',
    description: 'Get the public GitHub Pages URL for a content item.',
    inputSchema: z.object({
      id: z.string().describe('Item ID or type:id selector (e.g. "progit" or "book:progit")'),
    }),
  },
  async ({ id }) => {
    const { token, repo } = getConfig();
    const { items } = await github.fetchCatalog(repo, token);

    const { type: typeHint, id: itemId } = parseSelector(id);
    const item = findItem(items, itemId, typeHint);
    const url = buildItemUrl(repo, item);
    return { content: [{ type: 'text', text: JSON.stringify({ id: item.id, type: item.type, title: github.getDisplayTitle(item), url }, null, 2) }] };
  },
);

server.registerTool(
  'read_article',
  {
    title: 'Read Article',
    description: 'Read the markdown content of an article/document.',
    inputSchema: z.object({
      article_id: z.string().describe('Article ID (e.g. "deep-research-report")'),
    }),
  },
  async ({ article_id }) => {
    const { token, repo } = getConfig();
    const content = await github.readFile(repo, `docs/articles/${article_id}/content.md`, token);
    return { content: [{ type: 'text', text: content }] };
  },
);

// --- Tools: Write ---

server.registerTool(
  'edit_item',
  {
    title: 'Edit Item Metadata',
    description: 'Edit metadata for a content item (title, author, summary, tags, visibility, featured).',
    inputSchema: z.object({
      id: z.string().describe('Item ID or type:id selector'),
      title: z.string().optional().describe('New display title'),
      author: z.string().optional().describe('Author name'),
      summary: z.string().optional().describe('Short summary'),
      tags: z.array(z.string()).optional().describe('Tags list'),
      visibility: z.enum(['published', 'hidden', 'archived']).optional().describe('Visibility status'),
      featured: z.boolean().optional().describe('Featured on homepage'),
    }),
  },
  async ({ id, title, author, summary, tags, visibility, featured }) => {
    const { token, repo } = getConfig();
    const { items } = await github.fetchCatalog(repo, token);

    const { type: typeHint, id: itemId } = parseSelector(id);
    const { item: existing, index: idx } = findItemWithIndex(items, itemId, typeHint);
    const item = { ...existing, tags: [...(existing.tags || [])] };
    let changed = false;

    if (title !== undefined) { item.display_title = title; changed = true; }
    if (author !== undefined) { item.author = author; changed = true; }
    if (summary !== undefined) { item.summary = summary; changed = true; }
    if (tags !== undefined) { item.tags = tags; changed = true; }
    if (visibility !== undefined) { item.visibility = visibility; changed = true; }
    if (featured !== undefined) { item.featured = featured; changed = true; }

    if (!changed) {
      return { content: [{ type: 'text', text: 'No changes specified.' }] };
    }

    item.updated_at = new Date().toISOString();
    const next = items.map((i, j) => (j === idx ? item : i));
    await github.persistCatalog(repo, next, `chore(admin): edit ${item.type} ${item.id}`, token);

    return { content: [{ type: 'text', text: JSON.stringify({ status: 'updated', item }, null, 2) }] };
  },
);

server.registerTool(
  'delete_item',
  {
    title: 'Delete Item',
    description: 'Permanently delete a content item and all its files from the repository.',
    inputSchema: z.object({
      id: z.string().describe('Item ID or type:id selector'),
    }),
  },
  async ({ id }) => {
    const { token, repo } = getConfig();
    const { items } = await github.fetchCatalog(repo, token);

    const { type: typeHint, id: itemId } = parseSelector(id);
    const { item } = findItemWithIndex(items, itemId, typeHint);

    await github.deleteItem(item, repo, items, token);
    return { content: [{ type: 'text', text: JSON.stringify({ status: 'deleted', id: item.id, type: item.type }) }] };
  },
);

server.registerTool(
  'upload',
  {
    title: 'Upload Content',
    description: 'Upload a local file (.pdf, .epub, .md, or .zip) to GitShelf for processing.',
    inputSchema: z.object({
      file_path: z.string().describe('Absolute path to the file to upload'),
    }),
  },
  async ({ file_path: filePath }) => {
    const resolved = path.resolve(filePath);
    if (!fs.existsSync(resolved)) {
      return { content: [{ type: 'text', text: `File not found: ${resolved}` }], isError: true };
    }

    const ext = path.extname(resolved).slice(1).toLowerCase();
    if (!github.ACCEPTED_EXTENSIONS.includes(ext)) {
      return { content: [{ type: 'text', text: `Unsupported file type: .${ext}. Accepted: ${github.ACCEPTED_EXTENSIONS.join(', ')}` }], isError: true };
    }

    const { token, repo } = getConfig();
    const buffer = fs.readFileSync(resolved);
    const result = await github.uploadContent(resolved, buffer, repo, token);
    return { content: [{ type: 'text', text: JSON.stringify({ status: 'uploaded', ...result }, null, 2) }] };
  },
);

// --- Helpers ---

function parseSelector(selector) {
  const raw = String(selector || '').trim();
  const sep = raw.indexOf(':');
  if (sep === -1) return { id: raw, type: '' };
  return { type: raw.slice(0, sep).trim(), id: raw.slice(sep + 1).trim() };
}

function findItem(items, id, typeHint) {
  const matches = typeHint
    ? items.filter((i) => i.id === id && i.type === typeHint)
    : items.filter((i) => i.id === id);
  if (matches.length === 0) throw new Error(`Item not found: ${typeHint ? `${typeHint}:` : ''}${id}`);
  if (matches.length > 1) {
    const selectors = matches.map((i) => `${i.type}:${i.id}`).join(', ');
    throw new Error(`Multiple items share id "${id}". Use type:id (${selectors}).`);
  }
  return matches[0];
}

function findItemWithIndex(items, id, typeHint) {
  const item = findItem(items, id, typeHint);
  const index = items.indexOf(item);
  return { item, index };
}

function buildItemUrl(repo, item) {
  const [owner, name] = repo.split('/');
  const base = `https://${owner.toLowerCase()}.github.io/${name}/`;
  if (item.type === 'book') return `${base}#/books/${item.id}`;
  if (item.type === 'doc') return `${base}#/articles/${item.id}`;
  if (item.type === 'site') return `${base}sites/${item.id}/${item.entry || 'index.html'}`;
  return base;
}

// --- Start ---

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('GitShelf MCP server running on stdio');
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
