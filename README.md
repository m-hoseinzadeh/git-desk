# GitHub Repository Collaborator Viewer

A Node.js application that connects to your GitHub account, shows the collaborators on your repositories, and syncs your local clones with a web UI.

## Features

- 🖥️ Local web UI (`npm start`) with two tabs: **Sync** and **Collaborators**
- 🔄 **Sync**: finds every git clone under the app's parent directory and matches it to your GitHub repos
  - Fetch, pull (merge / rebase / fast-forward only) and push. The upstream is set on first push, and force-with-lease is offered after an amend
  - Stage, unstage or discard single files or everything; commit or amend
  - Stash changes, then apply, pop or drop stashes
  - Abort or continue a merge or rebase that stopped on conflicts
  - Switch branches (local or remote) and create new ones
  - Per-file diffs for staged, unstaged and untracked changes
  - Ahead/behind and uncommitted-change badges
  - **Fetch all**, and **Pull all**, which fetches everything and then fast-forwards clean repos that are behind
  - Clone account repos you don't have locally yet
  - Worktrees are grouped under their main repo; clones of repos outside your account are listed separately

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

Start the web UI (opens your browser at http://localhost:4321):

```bash
npm start
```

Or run the original console version, which prints the collaborators table:

```bash
npm run cli
```

### Sync

The Sync tab scans the directory above this project (for example `~/repo` if the app lives in `~/repo/repo-collaborators`) up to 4 levels deep. It skips `node_modules` and hidden folders. Each repo's `origin` remote is matched to your GitHub repos, and the results are shown in three sections:

- **Cloned**: account repos found on disk (worktrees are indented under their repo)
- **Local only**: clones whose remote isn't in your account
- **Not cloned**: account repos with no local copy; **Clone** puts them in the scan directory

Click a repository to stage files, view diffs, commit, switch or create branches, and pull/push. Statuses refresh whenever you switch back to the browser tab.

Git runs with your normal credentials (SSH keys, `core.sshCommand`, credential helpers). For `https://github.com` remotes the app also offers your `GITHUB_TOKEN`, but only when your own credential helpers have nothing. Prompts are disabled, so a missing credential shows up as an error instead of hanging.

Sync works without a `GITHUB_TOKEN`; every clone then shows as "local only".

### Options (`.env` or environment)

| Variable | Default | Purpose |
|---|---|---|
| `GITHUB_TOKEN` | – | GitHub personal access token |
| `PORT` | `4321` | Web UI port |
| `SCAN_ROOT` | parent of this project | Directory scanned for clones, and where new clones go |
| `SCAN_DEPTH` | `4` | How many directory levels to scan |
| `NO_OPEN` | – | Set to `1` to skip opening the browser |

## Error Handling

The application gracefully handles:
- **403 Forbidden**: When you don't have access to view collaborators (common with organization repos)
- **404 Not Found**: When a repository is not accessible
- **Rate Limiting**: Rate-limited requests are retried. Repositories that still fail are listed as failed instead of being dropped silently
- **Invalid Tokens**: Clear error messages for authentication issues

## API Rate Limits

GitHub's API has rate limits:
- **Authenticated requests**: 5,000 requests per hour
- The app retries rate-limited requests (waiting up to a minute) and reports any repositories it still couldn't load
- For accounts with many repositories, the process may take several minutes

## Security Notes

- The web UI listens on `127.0.0.1` only. It rejects requests with a foreign `Host` header and any cross-site write request, so other websites can't trigger git actions.
- Git only runs inside repositories found by the scan, and file paths sent to the API must stay inside that repository.
- The token is passed to git through the environment, never on the command line.

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
