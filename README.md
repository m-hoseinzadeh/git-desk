# GitHub Repository Collaborator Viewer

A Node.js application that connects to your GitHub account and displays all your repositories along with their collaborators.

## Features

- 📁 Lists all repositories (public and private) from your GitHub account
- 👥 Shows collaborators for each repository with their permissions
- 🔒 Handles private repositories and access permissions gracefully
- ⚡ Efficient pagination to handle accounts with many repositories
- 🛡️ Rate limit awareness to avoid API throttling
- 📊 Detailed repository information including stars, forks, and language

## Prerequisites

- Node.js (version 14 or higher)
- A GitHub account
- A GitHub Personal Access Token

## Setup

1. **Clone or download this project**

2. **Install dependencies**
   ```bash
   npm install
   ```

3. **Create a GitHub Personal Access Token**
   - Go to [GitHub Settings > Developer settings > Personal access tokens](https://github.com/settings/tokens)
   - Click "Generate new token (classic)"
   - Give it a descriptive name like "Repo Collaborator Viewer"
   - Select the following scopes:
     - `repo` (for access to private repositories)
     - OR `public_repo` (if you only want to see public repositories)
   - Click "Generate token"
   - **Important**: Copy the token immediately as you won't be able to see it again

4. **Configure environment variables**
   ```bash
   cp .env.example .env
   ```
   
   Edit the `.env` file and replace `your_github_personal_access_token_here` with your actual token:
   ```
   GITHUB_TOKEN=ghp_your_actual_token_here
   ```

## Usage

Run the application:

```bash
npm start
```

or

```bash
node index.js
```

The application will:
1. Test your GitHub connection
2. Fetch all your repositories
3. For each repository, fetch and display collaborators
4. Show detailed information including permissions and repository stats

## Sample Output

```
✅ Connected to GitHub as: yourusername (Your Name)

📊 Found 25 repositories. Fetching collaborators...

================================================================================

[1/25] Processing: yourusername/awesome-project

📁 yourusername/awesome-project
   Description: An awesome project for doing awesome things
   Private: No
   Language: JavaScript
   Stars: 42 | Forks: 7
   URL: https://github.com/yourusername/awesome-project
   👥 Collaborators (3):
      • yourusername (User) - admin, maintain, push, triage, pull
      • collaborator1 (User) - push, pull
      • collaborator2 (User) - pull
```

## Error Handling

The application gracefully handles:
- **403 Forbidden**: When you don't have access to view collaborators (common with organization repos)
- **404 Not Found**: When a repository is not accessible
- **Rate Limiting**: Automatic pausing to respect GitHub's API limits
- **Invalid Tokens**: Clear error messages for authentication issues

## API Rate Limits

GitHub's API has rate limits:
- **Authenticated requests**: 5,000 requests per hour
- The app includes automatic pausing to respect these limits
- For accounts with many repositories, the process may take several minutes

## Security Notes

- Never commit your `.env` file to version control
- Keep your GitHub token secure and don't share it
- The token gives access to your repositories according to the scopes you selected
- You can revoke the token anytime from your GitHub settings

## Troubleshooting

**"GITHUB_TOKEN environment variable is required!"**
- Make sure you created the `.env` file with your token

**"Authentication failed"**
- Check that your token is correct and hasn't expired
- Ensure the token has the necessary scopes

**"Rate limit exceeded"**
- Wait for the rate limit to reset (usually within an hour)
- The app will show when limits are hit

## License

MIT License - feel free to use and modify as needed.
