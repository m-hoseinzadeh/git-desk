const { mapLimit } = require('./concurrency');

/**
 * Build rows for repositories that have collaborators other than me
 * @param {GitHubClient} client - GitHub API client
 * @param {Array} repositories - Repository objects from the GitHub API
 * @param {string} myUsername - Login of the authenticated user
 * @param {Object} options - { concurrency, onResult } where onResult({ index, repo, row, failed })
 *   is called as each repository finishes, so callers can show progress
 * @returns {Promise<{rows: Array, failed: Array}>} rows: [{ repoName, fullName, others, owner, url }],
 *   failed: full names whose collaborators couldn't be fetched (e.g. rate limited)
 */
async function buildCollaboratorTable(client, repositories, myUsername, { concurrency = 3, onResult } = {}) {
  const failed = [];

  const rows = await mapLimit(repositories, concurrency, async (repo, index) => {
    let row;
    try {
      const collaborators = await client.getCollaborators(repo.owner.login, repo.name);
      row = toRow(repo, collaborators, myUsername);
    } catch (error) {
      failed.push(repo.full_name);
      if (onResult) onResult({ index, repo, row: null, failed: true });
      return null;
    }
    if (onResult) onResult({ index, repo, row, failed: false });
    return row;
  });

  return { rows: rows.filter(Boolean), failed };
}

/**
 * Convert a repository to a table row, or null if I'm the only collaborator
 */
function toRow(repo, collaborators, myUsername) {
  const otherCollaborators = collaborators.filter(c => c.login !== myUsername);

  if (otherCollaborators.length === 0) {
    return null;
  }

  return {
    repoName: repo.name,
    fullName: repo.full_name,
    others: otherCollaborators.map(c => c.login).join(', '),
    owner: repo.owner.login === myUsername ? 'Me' : repo.owner.login,
    url: repo.html_url
  };
}

module.exports = { buildCollaboratorTable, toRow };
