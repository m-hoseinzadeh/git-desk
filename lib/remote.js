/**
 * Normalize a git remote URL to "owner/repo" (lowercase) for GitHub remotes.
 * Supports https://github.com/o/r(.git), git@github.com:o/r.git, ssh://git@github.com/o/r
 * @param {string} url - Remote URL
 * @returns {string|null} "owner/repo" or null if not a GitHub remote
 */
function normalize(url) {
  if (!url) return null;
  const trimmed = url.trim();

  const patterns = [
    /^(?:https?|git|ssh):\/\/(?:[^@/]+@)?github\.com(?::\d+)?\/([^/]+)\/([^/]+?)\/?$/i,
    /^(?:[^@/]+@)?github\.com:([^/]+)\/([^/]+?)\/?$/i
  ];

  for (const re of patterns) {
    const m = trimmed.match(re);
    if (m) {
      const repo = m[2].replace(/\.git$/i, '');
      return `${m[1]}/${repo}`.toLowerCase();
    }
  }
  return null;
}

module.exports = { normalize };
