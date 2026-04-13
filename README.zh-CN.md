# GitShelf

[English](README.md)

基于 GitHub 的内容托管平台。Fork，上传，搞定。

> Fork 本仓库即可拥有自己的内容平台。上传 PDF 或 EPUB（转换后发布为在线书籍）、Markdown 文档（直接渲染）、ZIP 压缩包（部署为静态站点），全部托管在 GitHub Pages 上。零服务器成本。

## 快速开始

### 1. Fork 并启用 Pages

1. 点击本仓库的 **Fork** 按钮
2. 在你的 Fork 中，进入 **Settings > Pages**
3. **Source** 选择 **GitHub Actions**
4. 进入 **Actions** 标签页，选择 **Deploy to GitHub Pages**，点击 **Run workflow** 触发首次部署

站点已上线：`https://<your-username>.github.io/gitshelf/`

### 2. 添加 MinerU Token（用于 PDF 和 EPUB 转换）

1. 在 [mineru.net](https://mineru.net) 注册（测试期免费）
2. 复制 API Token
3. 在你的 Fork 中，进入 **Settings > Secrets and variables > Actions**
4. 点击 **New repository secret**，名称填 `MINERU_TOKEN`，粘贴 Token

> 书籍上传都需要。EPUB 会先经由 Calibre 转成 PDF，再进入和 PDF 相同的 MinerU 处理流水线。

### 3. 密码保护（可选）

1. 在你的 Fork 中，进入 **Settings > Secrets and variables > Actions**
2. 点击 **New repository secret**，名称填 `VITE_SITE_PASSWORD`，值填你的密码
3. 重新部署 — 访客需输入密码才能访问站点

> 不设置则站点保持公开访问。

### 4. 上传内容

1. 访问站点，点击顶栏的齿轮图标
2. 输入具有 `repo` 权限的 GitHub **Personal Access Token**
   （[点此创建](https://github.com/settings/tokens/new?scopes=repo&description=GitShelf)）
3. 上传文件：
   - **`.pdf`** — 通过 MinerU API 转换为多章节书籍
   - **`.epub`** — 先用 Calibre 转成 PDF，再复用和 PDF 相同的章节转换流程
   - **`.md`** — 直接作为文档渲染展示
   - **`.zip`** — 解压为静态站点（需包含 `index.html`）
4. 等待 GitHub Actions 处理完成
5. 内容出现在首页！

## 内容类型

| 类型 | 上传格式 | 展示方式 |
|------|----------|----------|
| **书籍** | `.pdf` 或 `.epub` | 章节阅读器 + TOC 侧栏 + 键盘导航 |
| **文档** | `.md` | 单页 Markdown 渲染，支持代码高亮和数学公式 |
| **站点** | `.zip` | 静态站点直接托管，点击新窗口打开 |

## 功能

- **阅读器** — 明暗主题、章节侧边栏、键盘导航、代码高亮（Shiki）、数学公式（KaTeX）、响应式布局
- **管理面板** — 上传 PDF/EPUB/Markdown/ZIP、目录管理（编辑、发布、隐藏、归档、删除）、搜索和筛选
- **处理流水线** — GitHub Actions 自动处理上传内容，大 PDF 自动分块转换
- **首页** — 标签页筛选：全部 / 书籍 / 文档 / 站点

## 工作原理

```
上传内容（浏览器 → GitHub API → input/）
  → GitHub Actions 运行 scripts/process.py
  → .pdf:  MinerU API → Markdown → 拆分章节 → docs/books/{id}/
  → .epub: Calibre → PDF → MinerU API → Markdown → 拆分章节 → docs/books/{id}/
  → .md:   复制到 docs/articles/{id}/content.md
  → .zip:  解压到 docs/sites/{id}/
  → 构建 manifest → GitHub Pages 部署
```

## 测试

```bash
npm test                                        # JS 单元测试
npm run test:frontend                           # 前端行为测试
python -m unittest discover -s tests/scripts -v # Python 流水线测试
```

## 常见问题

**需要在本地安装什么吗？** 不需要。一切在 GitHub Actions 和浏览器中运行。

**需要提交前端构建产物吗？** 不需要。`docs/index.html` 和 `docs/assets/` 由 `Deploy to GitHub Pages` 工作流生成。需要提交的是 `docs/books/`、`docs/articles/`、`docs/sites/`、`manifest.json`、`catalog.json` 这类内容数据；Pages 会在部署时重新构建前端 bundle。

**MinerU 收费了怎么办？** 修改 `scripts/mineru_client.py` 即可替换，兼容任何 PDF 转 Markdown 工具。

**可以手动编辑转换后的章节吗？** 可以。无论上传的是 PDF 还是 EPUB，最终都会生成 `docs/books/<id>/chapters/` 下的 Markdown 章节文件，可以直接编辑并提交。

**可以上传静态站点吗？** 可以。将站点打包为 `.zip`（根目录需包含 `index.html`），通过管理面板上传即可。

## 免责声明

仅供**个人学习和研究**使用。用户需自行确保拥有转换和托管内容的合法权利。未经授权请勿上传受版权保护的材料。

## 许可证

MIT
