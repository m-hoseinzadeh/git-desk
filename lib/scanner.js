const fs = require('fs/promises');
const path = require('path');
const git = require('./git');
const { mapLimit } = require('./concurrency');

const SKIP_DIRS = new Set(['node_modules', 'vendor', 'dist', 'build', 'target', '__pycache__', 'venv']);

/**
 * Recursively find git repositories (clones and worktrees) under root.
 * Does not descend into a repository once found and never follows symlinks.
 * @param {string} root - Directory to scan
 * @param {Object} options - { maxDepth }
 * @returns {Promise<string[]>} Absolute repository paths
 */
async function findRepoDirs(root, { maxDepth = 4 } = {}) {
  const found = [];

  async function walk(dir, depth) {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return; // Unreadable directory
    }

    if (entries.some(e => e.name === '.git' && (e.isDirectory() || e.isFile()))) {
      found.push(dir);
      return;
    }
    if (depth >= maxDepth) return;

    const subdirs = entries.filter(e =>
      e.isDirectory() && !e.name.startsWith('.') && !SKIP_DIRS.has(e.name)
    );
    await Promise.all(subdirs.map(e => walk(path.join(dir, e.name), depth + 1)));
  }

  await walk(path.resolve(root), 0);
  return found.sort();
}

/**
 * The git directory shared by all checkouts of a repository, read from disk to save a git call:
 * `.git` itself, or for a worktree the `commondir` file inside the directory its `.git` file
 * points to. Anything unexpected falls back to asking git.
 */
async function readCommonDir(dir, isWorktree) {
  const dotGit = path.join(dir, '.git');
  try {
    if (!isWorktree) return await fs.realpath(dotGit);
    const match = (await fs.readFile(dotGit, 'utf8')).match(/^gitdir:\s*(.+?)\s*$/m);
    const gitDir = path.resolve(dir, match[1]);
    const common = (await fs.readFile(path.join(gitDir, 'commondir'), 'utf8')).trim();
    return await fs.realpath(path.resolve(gitDir, common));
  } catch {
    return fs.realpath(await git.commonDir(dir));
  }
}

/**
 * Scan for repositories and collect remote and worktree info for each
 * @param {string} root - Directory to scan
 * @param {Object} options - { maxDepth }
 * @returns {Promise<Array>} [{ path, name, relPath, remotes, isWorktree, commonDir, error }]
 */
async function scan(root, options = {}) {
  const dirs = await findRepoDirs(root, options);

  return mapLimit(dirs, 8, async dir => {
    const repo = {
      path: dir,
      name: path.basename(dir),
      relPath: path.relative(root, dir) || '.',
      remotes: {},
      isWorktree: false,
      commonDir: path.join(dir, '.git'),
      error: null
    };
    try {
      const dotGit = await fs.stat(path.join(dir, '.git'));
      repo.isWorktree = dotGit.isFile();
      [repo.remotes, repo.commonDir] = await Promise.all([
        git.remotes(dir),
        readCommonDir(dir, repo.isWorktree)
      ]);
    } catch (error) {
      // Keep broken repositories visible so the problem shows up in the UI
      repo.error = error.message;
    }
    return repo;
  });
}

module.exports = { scan, findRepoDirs };
