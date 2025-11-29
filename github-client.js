const axios = require('axios');

class GitHubClient {
  constructor(token) {
    this.token = token;
    this.baseURL = 'https://api.github.com';
    this.headers = {
      'Authorization': `token ${token}`,
      'Accept': 'application/vnd.github.v3+json',
      'User-Agent': 'GitHub-Repo-Collaborators-App'
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
    try {
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
    } catch (error) {
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
