const axios = require('axios');

const MAX_RATE_LIMIT_WAIT_MS = 60 * 1000;
const MAX_RATE_LIMIT_RETRIES = 3;

/**
 * How long to wait before retrying a rate-limited response, or null if it isn't rate limited
 * @param {Object} response - axios error response
 * @returns {number|null} Milliseconds to wait
 */
function rateLimitDelay(response) {
  if (!response || (response.status !== 403 && response.status !== 429)) {
    return null;
  }
  const headers = response.headers || {};
  const message = String(response.data?.message || '');

  if (headers['retry-after']) {
    return Number(headers['retry-after']) * 1000;
  }
  if (headers['x-ratelimit-remaining'] === '0' && headers['x-ratelimit-reset']) {
    return Math.max(0, Number(headers['x-ratelimit-reset']) * 1000 - Date.now()) + 1000;
  }
  if (response.status === 429 || /rate limit/i.test(message)) {
    return 60 * 1000; // Secondary rate limit without a hint: GitHub asks for at least a minute
  }
  return null;
}

class GitHubClient {
  constructor(token) {
    this.token = token;
    this.baseURL = 'https://api.github.com';
    this.headers = {
      'Authorization': `token ${token}`,
      'Accept': 'application/vnd.github.v3+json',
      'User-Agent': 'git-desk'
    };
  }

  /**
   * Get all repositories for the authenticated user
   * @param {string} type - Type of repositories ('all', 'owner', 'member')
   * @returns {Promise<Array>} Array of repository objects
   */
  async getRepositories(type = 'all') {
    try {
      const allRepos = [];
      let page = 1;
      const perPage = 100;

      while (true) {
        const response = await axios.get(`${this.baseURL}/user/repos`, {
          headers: this.headers,
          params: {
            type: type,
            sort: 'updated',
            direction: 'desc',
            per_page: perPage,
            page: page
          }
        });

        const repos = response.data;
        allRepos.push(...repos);

        // If we got less than perPage results, we've reached the end
        if (repos.length < perPage) {
          break;
        }
        page++;
      }

      return allRepos;
    } catch (error) {
      console.error('Error fetching repositories:', error.response?.data || error.message);
      throw error;
    }
  }

  /**
   * Get collaborators for a specific repository
   * @param {string} owner - Repository owner
   * @param {string} repo - Repository name
   * @returns {Promise<Array>} Array of collaborator objects
   */
  async getCollaborators(owner, repo) {
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.fetchCollaborators(owner, repo);
      } catch (error) {
        const delay = rateLimitDelay(error.response);
        if (delay === null) {
          return this.handleCollaboratorError(owner, repo, error);
        }
        if (attempt >= MAX_RATE_LIMIT_RETRIES || delay > MAX_RATE_LIMIT_WAIT_MS) {
          const rateError = new Error(`GitHub rate limit hit while fetching collaborators for ${owner}/${repo}`);
          rateError.rateLimited = true;
          throw rateError;
        }
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }
  }

  /**
   * Fetch every page of collaborators for a repository
   */
  async fetchCollaborators(owner, repo) {
    const allCollaborators = [];
    let page = 1;
    const perPage = 100;

    while (true) {
      const response = await axios.get(`${this.baseURL}/repos/${owner}/${repo}/collaborators`, {
        headers: this.headers,
        params: {
          per_page: perPage,
          page: page
        }
      });

      const collaborators = response.data;
      allCollaborators.push(...collaborators);

      // If we got less than perPage results, we've reached the end
      if (collaborators.length < perPage) {
        break;
      }
      page++;
    }

    return allCollaborators;
  }

  /**
   * Treat "no access" responses as having no visible collaborators
   */
  handleCollaboratorError(owner, repo, error) {
    if (error.response?.status === 403) {
      console.warn(`Access denied for ${owner}/${repo} - might be a private repo or insufficient permissions`);
      return [];
    } else if (error.response?.status === 404) {
      console.warn(`Repository ${owner}/${repo} not found or not accessible`);
      return [];
    }
    console.error(`Error fetching collaborators for ${owner}/${repo}:`, error.response?.data || error.message);
    return [];
  }

  /**
   * Get authenticated user information
   * @returns {Promise<Object>} User object
   */
  async getUser() {
    try {
      const response = await axios.get(`${this.baseURL}/user`, {
        headers: this.headers
      });
      return response.data;
    } catch (error) {
      console.error('Error fetching user information:', error.response?.data || error.message);
      throw error;
    }
  }

  /**
   * Test the GitHub token validity
   * @returns {Promise<boolean>} True if token is valid
   */
  async testConnection() {
    try {
      await this.getUser();
      return true;
    } catch (error) {
      return false;
    }
  }
}

module.exports = GitHubClient;
