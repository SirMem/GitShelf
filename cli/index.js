#!/usr/bin/env node

/**
 * GitShelf CLI — manage your GitShelf content from the command line.
 *
 * Usage:
 *   gitshelf <command> [options]
 *
 * Config (in order of priority):
 *   --token <pat>       GitHub Personal Access Token
 *   --repo <owner/name> Target repository
 *   GITSHELF_TOKEN      Environment variable for token
 *   GITSHELF_REPO       Environment variable for repo
 *   .gitshelfrc         Optional JSON config in current directory
 *   ~/.config/gitshelf/config.json  Default JSON config for npx/global use
 *                                  (or $XDG_CONFIG_HOME/gitshelf/config.json)
 */

const HELP = `
GitShelf CLI

Usage:
  gitshelf <command> [options]

Commands:
  upload <file>                Upload .pdf, .epub, .md, or .zip to GitShelf
  list [--type TYPE]           List all content items
  info <id|type:id>            Show details for one item
  edit <id|type:id> [...]      Edit item metadata
  delete <id|type:id> [--yes]  Delete an item permanently
  reconvert <id|type:id>       Trigger re-processing for a book source
  failures                     List processing failures
  failures dismiss <filename>  Dismiss a failure
  failures retry <filename>    Retry a failed conversion
  mcp                          Start MCP server (stdio transport)

Options:
  --token <pat>       GitHub PAT (or set GITSHELF_TOKEN)
  --repo <owner/name> Repository (or set GITSHELF_REPO)
  --json              Output as JSON (for agent consumption)
  --yes               Skip confirmation prompts
  --help              Show this help

Examples:
  gitshelf upload paper.pdf
  gitshelf list --type book --json
  gitshelf edit my-book --title "New Title" --visibility hidden
  gitshelf delete doc:old-doc --yes

Example .gitshelfrc:
  { "repo": "owner/repo", "token": "github_pat_..." }

Default config file:
  ~/.config/gitshelf/config.json
  or $XDG_CONFIG_HOME/gitshelf/config.json
`.trim();

async function main() {
  const argv = process.argv.slice(2);

  if (argv.length === 0 || argv.includes('--help') || argv.includes('-h')) {
    console.log(HELP);
    process.exit(0);
  }

  const command = argv[0];
  const commandArgv = argv.slice(1);

  const commands = {
    upload: () => require('./commands/upload'),
    list: () => require('./commands/list'),
    info: () => require('./commands/info'),
    edit: () => require('./commands/edit'),
    delete: () => require('./commands/delete'),
    reconvert: () => require('./commands/reconvert'),
    failures: () => require('./commands/failures'),
    mcp: () => ({ run: () => import('./mcp-server.mjs') }),
  };

  if (!commands[command]) {
    console.error(`Unknown command: ${command}\n`);
    console.log(HELP);
    process.exit(1);
  }

  try {
    await commands[command]().run(commandArgv);
  } catch (err) {
    if (argv.includes('--json')) {
      process.stdout.write(JSON.stringify({ error: err.message }) + '\n');
    } else {
      console.error(`Error: ${err.message}`);
    }
    process.exit(1);
  }
}

main();
