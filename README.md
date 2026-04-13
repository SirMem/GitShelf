# GitShelf

[中文](README.zh-CN.md)

GitHub-hosted content shelf. Fork, upload, done.

> Fork this repo to get your own content platform on GitHub Pages. Upload PDFs or EPUBs (converted into online books), Markdown documents (rendered directly), or ZIP archives (deployed as static sites). Zero server cost.

## Quick Start

### 1. Fork & Enable Pages

1. Click **Fork** on this repository
2. In your fork, go to **Settings > Pages**
3. Under **Source**, select **GitHub Actions**
4. Go to the **Actions** tab, select **Deploy to GitHub Pages**, click **Run workflow** to trigger the first deployment

Your site is now live at `https://<your-username>.github.io/gitshelf/`

### 2. Add MinerU Token (for PDF and EPUB conversion)

1. Register at [mineru.net](https://mineru.net) (free during beta)
2. Copy your API token
3. In your fork, go to **Settings > Secrets and variables > Actions**
4. Click **New repository secret**, name it `MINERU_TOKEN`, paste the token

> Needed for book uploads. EPUB files are converted to PDF first, then processed by the same MinerU pipeline as PDFs.

### 3. Password Protection (Optional)

1. In your fork, go to **Settings > Secrets and variables > Actions**
2. Click **New repository secret**, name it `VITE_SITE_PASSWORD`, set your password
3. Re-deploy — visitors must now enter the password to access the site

> Leave unset to keep the site public.

### 4. Upload Content

1. Visit your site and click the gear icon in the top bar
2. Enter a GitHub **Personal Access Token** with `repo` scope
   ([Create one here](https://github.com/settings/tokens/new?scopes=repo&description=GitShelf))
3. Upload a file:
   - **`.pdf`** — Converted to a multi-chapter book via MinerU API
   - **`.epub`** — Converted to PDF with Calibre, then processed through the same chapter pipeline as PDFs
   - **`.md`** — Rendered directly as a document
   - **`.zip`** — Extracted as a static site (must contain `index.html`)
4. Wait for GitHub Actions to process (progress shown in Actions tab)
5. Your content appears on the homepage!

## Content Types

| Type | Upload | Display |
|------|--------|---------|
| **Book** | `.pdf` or `.epub` file | Chapter reader with TOC sidebar, keyboard navigation |
| **Document** | `.md` file | Single-page Markdown rendering with syntax highlighting |
| **Site** | `.zip` file | Static site served directly (clicks open in new tab) |

## Features

- **Reader** — Dark/light theme, chapter sidebar, keyboard navigation, code highlighting (Shiki), math rendering (KaTeX), responsive layout
- **Admin** — Upload PDFs/EPUBs/Markdown/ZIPs from browser, catalog management (edit, publish, hide, archive, delete), search & filter
- **Pipeline** — GitHub Actions processes uploads automatically, handles large PDFs by auto-chunking
- **Homepage** — Tab-based filtering: All / Books / Documents / Sites

## How It Works

```
Upload content (browser → GitHub API → input/)
  → GitHub Actions runs scripts/process.py
  → .pdf:  MinerU API → Markdown → Split chapters → docs/books/{id}/
  → .epub: Calibre → PDF → MinerU API → Markdown → Split chapters → docs/books/{id}/
  → .md:   Copy to docs/articles/{id}/content.md
  → .zip:  Extract to docs/sites/{id}/
  → Build manifest → GitHub Pages deploys
```

## Testing

```bash
npm test                                        # JS unit tests
npm run test:frontend                           # Frontend behavior tests
python -m unittest discover -s tests/scripts -v # Python pipeline tests
```

## FAQ

**Do I need to install anything locally?** No. Everything runs in GitHub Actions and your browser.

**Do I need to commit frontend build files?** No. `docs/index.html` and `docs/assets/` are generated in the `Deploy to GitHub Pages` workflow. Commit content data such as `docs/books/`, `docs/articles/`, `docs/sites/`, `manifest.json`, and `catalog.json`; Pages rebuilds the frontend bundle during deployment.

**What if MinerU stops being free?** Swap it by modifying `scripts/mineru_client.py`. Works with any PDF-to-Markdown tool.

**Can I edit converted chapters?** Yes. Books uploaded as either PDF or EPUB end up as generated Markdown chapters in `docs/books/<id>/chapters/`, which you can edit and commit.

**Can I upload a static site?** Yes. Package it as a `.zip` with `index.html` at the root and upload through the admin panel.

## Agent Integration

### Skill (Claude Code / Codex)

```bash
npx skills add Praeviso/GitShelf
```

Once installed, your agent can manage GitShelf content via natural language — upload files, list items, edit metadata, delete content, and check failures.

### MCP Server

Add to your MCP client config (Claude Code, Cursor, etc.):

```json
{
  "mcpServers": {
    "gitshelf": {
      "command": "npx",
      "args": ["-y", "@praeviso/gitshelf", "mcp"],
      "env": {
        "GITSHELF_TOKEN": "ghp_xxx",
        "GITSHELF_REPO": "owner/repo"
      }
    }
  }
}
```

Provides tools to list content, read book chapters and articles, edit metadata, upload files, and delete items.

## Disclaimer

For **personal study and research only**. Users are responsible for ensuring they have the legal right to convert and host any content. Do not upload copyrighted material without permission. See full disclaimer in the [LICENSE](LICENSE) file.

## License

MIT

## Community

thank to https://linux.do
