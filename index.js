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
    this.others = []
    this.mine = []
    this.unknown = []
  }

  /**
   * Format and display repository information with collaborators
   */
  displayRepoInfo(repo, collaborators) {
    if (collaborators.length === 0) {
      this.unknown.push(repo.full_name)
      return;
    }
    if (collaborators.length === 1 && collaborators[0].login === 'm-hoseinzadeh') {
      this.mine.push(repo.full_name)
      return;
    }
    if (repo.full_name.indexOf('m-hoseinzadeh') !== 0) {
      this.others.push(repo.full_name)
      return;
    }
    const c = collaborators.filter(c => c.login !== 'm-hoseinzadeh').map(c => c.login).join(', ')
    console.log(`\n📁 ${repo.full_name}: ${c}`);
    // console.log(`   Description: ${repo.description || 'No description'}`);
    // console.log(`   Private: ${repo.private ? 'Yes' : 'No'}`);
    // console.log(`   Language: ${repo.language || 'Not specified'}`);
    // console.log(`   Stars: ${repo.stargazers_count} | Forks: ${repo.forks_count}`);
    // console.log(`   URL: ${repo.html_url}`);

    // if (collaborators.length === 0) {
    //   console.log(`   👥 Collaborators: None or access denied`);
    // } else {
    //   console.log(`   👥 Collaborators (${collaborators.length}):`);
    //   collaborators.forEach(collaborator => {
    //     const permissions = collaborator.permissions ? 
    //       Object.entries(collaborator.permissions)
    //         .filter(([key, value]) => value)
    //         .map(([key]) => key)
    //         .join(', ') : 'Unknown';

    //     console.log(`      • ${collaborator.login} (${collaborator.type}) - ${permissions}`);
    //     if (collaborator.site_admin) {
    //       console.log(`        🔧 Site Admin`);
    //     }
    //   });
    // }
  }

  /**
   * Main function to fetch and display all repositories with collaborators
   */
  async run() {
    try {
      console.log('🔍 Testing GitHub connection...');
      const isConnected = await this.client.testConnection();

      if (!isConnected) {
        console.error('❌ Failed to connect to GitHub. Please check your token.');
        return;
      }

      const user = await this.client.getUser();
      console.log(`✅ Connected to GitHub as: ${user.login} (${user.name || 'No name set'})`);

      console.log('\n🔄 Fetching repositories...');
      const repositories = await this.client.getRepositories();

      if (repositories.length === 0) {
        console.log('No repositories found.');
        return;
      }

      console.log(`\n📊 Found ${repositories.length} repositories. Fetching collaborators...\n`);

      let processedCount = 0;
      for (const repo of repositories) {
        processedCount++;
        // console.log(`\n[${processedCount}/${repositories.length}] Processing: ${repo.full_name}`);

        const collaborators = await this.client.getCollaborators(repo.owner.login, repo.name);
        this.displayRepoInfo(repo, collaborators);

        // Add a small delay to avoid hitting rate limits too hard
        if (processedCount % 10 === 0) {
          // console.log('\n⏳ Pausing briefly to respect rate limits...');
          await new Promise(resolve => setTimeout(resolve, 1000));
        }
      }

      console.log(`✅ Completed! Processed ${repositories.length} repositories.`);
      if (this.unknown.length > 0)
        console.log(`\n\n [unknown repositories]: ${this.unknown.join(', ')}`);
      if (this.mine.length > 0)
        console.log(`\n\n [mine repositories]: ${this.mine.join(', ')}`);
      if (this.others.length > 0)
        console.log(`\n\n [others repositories]: ${this.others.join(', ')}`);

    } catch (error) {
      console.error('❌ An error occurred:', error.message);
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
