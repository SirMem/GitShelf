const { fetchCatalog, triggerReconvert } = require('../github');
const { loadConfig, getPositional, hasFlag, selectCatalogItem, jsonOut, die } = require('../util');

async function run(argv) {
  const id = getPositional(argv, 0);
  if (!id) die('Usage: gitshelf reconvert <id|type:id> [--clear-cache]');

  const { token, repo } = loadConfig(argv);
  const { items } = await fetchCatalog(repo, token);
  const { item } = selectCatalogItem(items, id);
  if (item.type !== 'book') die('Only books can be re-processed. Re-upload Markdown or ZIP sources instead.');

  const clearCache = hasFlag(argv, '--clear-cache');
  await triggerReconvert(item, repo, token, { clearCache });

  if (hasFlag(argv, '--json')) {
    jsonOut({ status: 'triggered', id: item.id, type: item.type, source: item.source, clearCache });
  } else {
    console.log(`Reconversion triggered: ${item.type}:${item.id} (${item.source})`);
    if (clearCache) console.log('Cache cleared.');
    console.log(`Track progress: https://github.com/${repo}/actions`);
  }
}

module.exports = { run };
