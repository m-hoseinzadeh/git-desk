require('dotenv').config();
const GitHubClient = require('./github-client');

class GitHubRepoCollaboratorViewer {
  constructor() {
    this.token = process.env.GITHUB_TOKEN;
    if (!this.token) {
      console.error('❌ GITHUB_TOKEN environment variable is required!');
      console.log('Please create a .env file with your GitHub personal access token:');
      console.log('GITHUB_TOKEN=your_github_token_here');
      process.exit(1);
    }
    this.client = new GitHubClient(this.token);
    this.myUsername = null;
    this.tableData = [];
  }

  /**
   * Process repository and add to table if it has other collaborators
   */
  processRepo(repo, collaborators) {
    const otherCollaborators = collaborators.filter(c => c.login !== this.myUsername);

    if (otherCollaborators.length === 0) {
      return;
    }

    const repoName = repo.name;
    const others = otherCollaborators.map(c => c.login).join(', ');
    const owner = repo.owner.login === this.myUsername ? 'Me' : repo.owner.login;

    this.tableData.push({ repoName, others, owner });
  }

  /**
   * Display results as a table
   */
  displayTable() {
    if (this.tableData.length === 0) {
      console.log('\nNo repositories with other collaborators found.');
      return;
    }

    console.log('\n');
    console.table(this.tableData.map(row => ({
      'Repository': row.repoName,
      'Collaborators': row.others,
      'Owner': row.owner
    })));
  }

  /**
   * Main function to fetch and display all repositories with collaborators
   */
  async run() {
    try {
      console.log('Testing GitHub connection...');
      const isConnected = await this.client.testConnection();

      if (!isConnected) {
        console.error('Failed to connect to GitHub. Please check your token.');
        return;
      }

      const user = await this.client.getUser();
      this.myUsername = user.login;
      console.log(`Connected to GitHub as: ${user.login}`);

      console.log('Fetching repositories...');
      const repositories = await this.client.getRepositories();

      if (repositories.length === 0) {
        console.log('No repositories found.');
        return;
      }

      console.log(`Found ${repositories.length} repositories. Fetching collaborators...`);

      let processedCount = 0;
      for (const repo of repositories) {
        processedCount++;

        const collaborators = await this.client.getCollaborators(repo.owner.login, repo.name);
        this.processRepo(repo, collaborators);

        if (processedCount % 10 === 0) {
          await new Promise(resolve => setTimeout(resolve, 1000));
        }
      }

      this.displayTable();

    } catch (error) {
      console.error('An error occurred:', error.message);
      if (error.response?.status === 401) {
        console.error('Authentication failed. Please check your GitHub token.');
      } else if (error.response?.status === 403) {
        console.error('Rate limit exceeded or insufficient permissions.');
      }
    }
  }
}

// Run the application
if (require.main === module) {
  const app = new GitHubRepoCollaboratorViewer();
  app.run().catch(console.error);
}

module.exports = GitHubRepoCollaboratorViewer;
