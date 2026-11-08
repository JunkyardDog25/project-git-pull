# Project Git Pull

Never forget to update your team branch again.

When you open a project, **Project Git Pull** checks the remote, tells you if your team branch (for example `develop`) is behind, and can pull the new commits for you. It also notices when you are on a different branch than the one your team works on and offers to switch.

It uses VS Code's built-in Git extension, so it works with any remote (GitHub, GitLab, Bitbucket, ...) and with the credentials you already have set up. No extra login is needed.

## Features

- **Automatic check on startup.** When a window with a Git repository opens, the extension runs `git fetch` and compares your branch with its remote.
- **Pull when you are behind.** If you are on the team branch and the remote has new commits, you get a notification with a **Pull** button (or the pull happens automatically, see [Settings](#settings)).
- **Switch to the team branch.** If you are on another branch and have no uncommitted changes, you are offered **Switch to develop and pull**.
- **Activity Bar view.** A dedicated sidebar shows the state of every repository and a history of everything the extension did, so you do not depend on status bar messages or notifications.
- **Safe by default.** Nothing is switched or pulled while you have uncommitted changes, and local commits that are not pushed always trigger a question instead of an automatic pull.

## The sidebar

Click the **Project Git Pull** icon in the Activity Bar.

**Repositories**

- One row per repository with the current branch and its state (`up to date`, `3 commit(s) behind`, `not on "develop"`, ...).
- Expand a row to see the branch, upstream, behind/ahead counts, number of uncommitted changes and the time of the last check.
- Inline buttons appear when an action makes sense: **Pull** when you are behind, **Switch to Team Branch and Pull** when you are on another branch.
- A badge on the Activity Bar icon shows how many repositories need your attention.
- The **Sync Now** button in the view title checks all repositories again.

**Activity**

- A list of the most recent events (up to 100), newest first, with time and a colored icon: successful pulls, warnings, errors, and "up to date" confirmations.
- Hover over an entry to see its full text.
- Toolbar buttons: **Show Output** and **Clear**.

Detailed technical logging is also written to **Output → Project Git Pull**.

## What happens in each situation

| Situation | What the extension does |
|---|---|
| On the team branch, behind the remote, no uncommitted changes | Asks to pull (`ask` mode) or pulls automatically (`auto` mode) |
| On the team branch, behind the remote, you have local commits that are not pushed | Always asks, even in `auto` mode, because a pull may create a merge commit |
| On the team branch, behind the remote, you have uncommitted changes | Does not pull, shows a warning |
| On another branch, no uncommitted changes | Offers to switch to the team branch and pull |
| On another branch, you have uncommitted changes | Does nothing and notes it in the Activity view |
| Branch has no upstream | Warns in the Activity view (fix with `git branch --set-upstream-to=origin/<branch>`) |
| Detached HEAD | Notes it in the Activity view and does nothing |
| Fetch fails (offline, no access) | Warns in the Activity view |
| Already up to date | Confirms in the Activity view |

Pop-up notifications are used only when you need to make a decision or when something went wrong. Everything else is shown in the sidebar.

## Commands

Open the Command Palette (`Ctrl+Shift+P` / `Cmd+Shift+P`) and search for:

| Command | Description |
|---|---|
| **Project Git Pull: Sync Now** | Checks all open repositories immediately and opens the sidebar |
| **Project Git Pull: Show Output** | Opens the detailed log |
| **Project Git Pull: Clear Activity** | Clears the Activity list |

## Settings

| Setting | Default | Description |
|---|---|---|
| `projectGitPull.branch` | `develop` | The team's main branch that should be kept up to date |
| `projectGitPull.mode` | `ask` | `ask` shows a notification before pulling. `auto` pulls without asking, but only when you have no uncommitted changes and no unpushed local commits |

Different projects use different branch names. To set the branch for one project only, add this to the project's `.vscode/settings.json`:

```json
{
  "projectGitPull.branch": "main"
}
```

## Requirements

- VS Code 1.145 or newer
- Git installed and the built-in Git extension enabled (`git.enabled`)
- A repository with a configured remote and an upstream branch

## Good to know

- The check runs when a repository is opened and when you run **Sync Now**. It does not run on a timer.
- Only the configured team branch is kept up to date. Other branches are never touched.
- Pulling is done by VS Code's Git extension, so your Git configuration (for example `pull.rebase`) applies.
- The extension does not call the GitHub API and sends no data anywhere. It only runs Git commands in your repositories.

## Troubleshooting

**"No Git repository was found in this window."** Open a folder that is a Git repository (or a subfolder of one). If the folder is inside a repository, VS Code may ask whether to open the repository from the parent folder; confirm it.

**The extension says a branch "has no upstream".** Link the local branch to its remote branch:

```bash
git branch --set-upstream-to=origin/<branch> <branch>
```

**Nothing happens at startup.** Check **Activity** and **Output → Project Git Pull** to see what the extension decided and why. A failed fetch (offline, expired credentials) is reported there.

## Installing from a `.vsix` file

1. Open the Extensions view.
2. Click the three dots (`⋯`) at the top right and choose **Install from VSIX...**.
3. Select the `.vsix` file and reload the window.

Or from a terminal:

```bash
code --install-extension project-git-pull-0.0.1.vsix
```

## Release notes

### 0.0.1

Initial release: startup check, pull and branch switch offers, Activity Bar views.