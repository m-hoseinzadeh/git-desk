# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

A Node.js app with a local web UI (plus the original CLI) that:
- shows collaborators on the authenticated user's GitHub repositories
- **syncs** local clones: it scans the parent directory for git repos, matches them to account repos, and offers fetch/pull/push/stage/discard/commit/amend/stash/branch/diff/clone, remote management (add/rename/set URL and push URL/remove, fetch one remote), a selectable pull/push remote per repo (remembered in localStorage; defaults to what plain `git pull`/`git push` would use), merge/rebase abort/continue, and fetch-all/pull-all.

## Commands

```bash
npm install    # Install dependencies
npm start      # Web UI on http://localhost:4321 (server.js)
npm run cli    # Console collaborators table (index.js)
npm run dev    # Web UI with node --watch
```

## Configuration

Requires a GitHub Personal Access Token in `.env`:
```
GITHUB_TOKEN=ghp_...
```

Optional: `PORT`, `SCAN_ROOT` (default: parent of this repo), `SCAN_DEPTH` (default 4), `NO_OPEN=1`.

Create token at https://github.com/settings/tokens with `repo` scope (or `public_repo` for public repos only).

## Architecture

- `server.js` - Express app bound to 127.0.0.1. Serves `public/` and the JSON API (`/api/me`, `/api/collaborators`, `/api/sync`, `/api/sync/fetch-all`, `/api/sync/pull-all`, `/api/repo/status|diff`, `POST /api/repo/:action`, `/api/clone`). A middleware checks the Host header, requires `X-Requested-With: repo-collaborators` on every `/api/` call, and requires a localhost Origin on writes. Repos are addressed by scan id, never by raw path. File paths go through `repoPaths()`; untracked diffs also go through `realRepoPath()` (symlink check). Action responses include `detail` plus `summaries` for the repo and its worktrees, so the client patches the list without rescanning. `remote-*` actions re-read remotes into the scan cache for every checkout sharing the git dir (`reloadRemotes`) and also send `locals`, since the GitHub match can change. Slow endpoints (`/api/sync`, `/api/sync/fetch-all`, `/api/sync/pull-all`, `/api/collaborators`) stream NDJSON events through `streamRoute()` so results show up one by one; `/api/sync` sends `account`, `locals` (cached scan first, again after a rescan) and one `status` per repo, and the client does the matching. A collaborators run is shared between requests (`collaboratorRun`: late requests replay its events) and a run without failures is the cache.
- `index.js` - CLI (`GitHubRepoCollaboratorViewer`) printing the collaborators table
- `github-client.js` - `GitHubClient` wrapping GitHub REST API v3 with pagination; `getCollaborators` retries rate limits and throws (`rateLimited`) when it can't wait
- `lib/collaborators.js` - builds `{ rows, failed }` (shared by CLI and server)
- `lib/concurrency.js` - `mapLimit` helper
- `lib/scanner.js` - recursive repo discovery (`.git` dir or worktree file; does not descend into repos). The shared git dir is read from disk (`commondir`), falling back to git
- `lib/remote.js` - normalizes GitHub remote URLs to lowercase `owner/repo`
- `lib/git.js` - git wrappers using `execFile` (no shell), `GIT_TERMINAL_PROMPT=0`, porcelain v2 status parser. Network commands go through `runNetwork`: it sets `GIT_SSH_COMMAND` only if no `core.sshCommand` is configured, and adds a lowest-priority credential helper that supplies `GITHUB_TOKEN` from the env via `GIT_CONFIG_*`
- `public/` - vanilla JS frontend. `app.js` builds the DOM with an `h()` helper that sets text only through textContent. `detailSeq`/`diffSeq` drop stale responses. `rebuildPreservingFocus` keeps input focus across re-renders. Drafts live in `state.drafts`, not the DOM. `stream()` reads NDJSON. List updates are batched per animation frame: a full rebuild only when the repo set or account changed, otherwise `patchRow()` updates single rows; unchanged data renders nothing. Coming back to the window after 10s+ triggers a quiet refresh. Log boxes are built with `logBox()` and `restoreLogScroll()` re-pins them to the end after a render unless the user scrolled up

Dependencies: axios, dotenv, express.
