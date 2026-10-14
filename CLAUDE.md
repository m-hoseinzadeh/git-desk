# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

A Node.js CLI tool that fetches all GitHub repositories for an authenticated user and displays collaborators for each repository. It categorizes repositories into "mine" (solo), "others" (not owned), and "unknown" (no collaborator access).

## Commands

```bash
npm install    # Install dependencies
npm start      # Run the application (or: node index.js)
```

## Configuration

Requires a GitHub Personal Access Token in `.env`:
```
GITHUB_TOKEN=ghp_...
```

Create token at https://github.com/settings/tokens with `repo` scope (or `public_repo` for public repos only).

## Architecture

Two main files:
- `index.js` - Main application class (`GitHubRepoCollaboratorViewer`) that orchestrates fetching and categorizes repos into `mine`, `others`, and `unknown` arrays
- `github-client.js` - `GitHubClient` class wrapping GitHub REST API v3 with pagination support for repos and collaborators

The app uses axios for HTTP requests and dotenv for environment configuration.
