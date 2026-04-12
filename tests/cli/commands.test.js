/* @vitest-environment node */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const Module = require('node:module');

const githubPath = require.resolve('../../cli/github.js');
const utilPath = require.resolve('../../cli/util.js');

function installModuleExports(modulePath, exports) {
  const mod = new Module(modulePath);
  mod.filename = modulePath;
  mod.paths = Module._nodeModulePaths(process.cwd());
  mod.loaded = true;
  mod.exports = exports;
  require.cache[modulePath] = mod;
}

function loadCommand(commandName, overrides = {}) {
  const commandPath = require.resolve(`../../cli/commands/${commandName}.js`);

  delete require.cache[githubPath];
  delete require.cache[utilPath];
  delete require.cache[commandPath];

  const actualGithub = require(githubPath);
  const actualUtil = require(utilPath);

  installModuleExports(githubPath, { ...actualGithub, ...(overrides.github || {}) });
  installModuleExports(utilPath, { ...actualUtil, ...(overrides.util || {}) });

  delete require.cache[commandPath];
  return require(commandPath);
}

afterEach(() => {
  for (const modulePath of [
    githubPath,
    utilPath,
    require.resolve('../../cli/commands/edit.js'),
    require.resolve('../../cli/commands/list.js'),
    require.resolve('../../cli/commands/reconvert.js'),
  ]) {
    delete require.cache[modulePath];
  }
  vi.restoreAllMocks();
});

describe('cli commands', () => {
  it('keeps the generated title intact when setting a display title', async () => {
    const fetchCatalog = vi.fn().mockResolvedValue({
      items: [
        { id: 'doc-1', type: 'doc', title: 'Generated Title', display_title: '', tags: [], visibility: 'published' },
      ],
    });
    const persistCatalog = vi.fn().mockResolvedValue(undefined);
    const jsonOut = vi.fn();

    const { run } = loadCommand('edit', {
      github: { fetchCatalog, persistCatalog },
      util: {
        loadConfig: () => ({ token: 'token', repo: 'owner/repo' }),
        jsonOut,
      },
    });

    await run(['doc-1', '--title', 'Pretty Title', '--json']);

    expect(persistCatalog).toHaveBeenCalledTimes(1);
    const nextItems = persistCatalog.mock.calls[0][1];
    expect(nextItems[0]).toMatchObject({
      id: 'doc-1',
      type: 'doc',
      title: 'Generated Title',
      display_title: 'Pretty Title',
    });
    expect(jsonOut).toHaveBeenCalledWith(expect.objectContaining({
      status: 'updated',
      item: expect.objectContaining({
        title: 'Generated Title',
        display_title: 'Pretty Title',
      }),
    }));
  });

  it('shows display titles in list output', async () => {
    const fetchCatalog = vi.fn().mockResolvedValue({
      items: [
        { id: 'doc-1', type: 'doc', title: 'Generated Title', display_title: 'Pretty Title', visibility: 'published', source: 'doc-1.md' },
      ],
    });
    const tableOut = vi.fn();
    vi.spyOn(console, 'log').mockImplementation(() => {});

    const { run } = loadCommand('list', {
      github: { fetchCatalog },
      util: {
        loadConfig: () => ({ token: 'token', repo: 'owner/repo' }),
        tableOut,
      },
    });

    await run([]);

    expect(tableOut).toHaveBeenCalledTimes(1);
    const [rows, columns] = tableOut.mock.calls[0];
    expect(rows).toHaveLength(1);
    expect(columns.find((column) => column.header === 'TITLE').value(rows[0])).toBe('Pretty Title');
  });

  it('refuses to reconvert non-book content', async () => {
    const triggerReconvert = vi.fn();

    const { run } = loadCommand('reconvert', {
      github: {
        fetchCatalog: vi.fn().mockResolvedValue({
          items: [
            { id: 'doc-1', type: 'doc', title: 'Doc 1', source: 'doc-1.md' },
          ],
        }),
        triggerReconvert,
      },
      util: {
        loadConfig: () => ({ token: 'token', repo: 'owner/repo' }),
        die: (message) => { throw new Error(message); },
      },
    });

    await expect(run(['doc-1'])).rejects.toThrow(
      'Only books can be re-processed. Re-upload Markdown or ZIP sources instead.',
    );
    expect(triggerReconvert).not.toHaveBeenCalled();
  });
});
