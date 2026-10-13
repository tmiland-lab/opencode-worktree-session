# opencode-worktree-session

A plugin for [OpenCode](https://opencode.ai) that automatically manages Git worktrees for every AI session created from the [opencode-plugin-template](https://github.com/zenobi-us/opencode-plugin-template).

This plugin ensures your main working directory remains clean while the AI works in an isolated branch. On session end, it automatically generates a commit message, pushes the branch, and removes the worktree.

## Features

- **Isolation:** Automatically creates a new Git worktree in `.opencode/worktrees/`.
- **Safety:** Refuses to run on the `main` branch to prevent accidental corruption.
- **Context-Aware:** Pivots the AI's working directory (`cwd`) to the worktree automatically.
- **Automated Cleanup:** Commits changes using AI-generated messages and deletes the worktree upon exit.

## Installation

### NPM

Add to your `opencode.json`:

```json
{
  "plugin": ["@tmegit/opencode-worktree-session"]
}
```

### OpenCode V2 (server plugins)

V2 discovers plugins from the config `plugin` array (npm specs resolve through
the package's `./server` export) or from local files in `.opencode/plugins/`
(project) and `~/.config/opencode/plugins/` (global). This fork ships a V2 entry
at `v2/server.ts` that reimplements the worktree workflow with the V2 API
(`ctx.worktree`, `ctx.session`, `ctx.tool`); the root `server.ts` dispatches to
it. Reference the package in the config:

```json
{
  "plugin": ["@tmegit/opencode-worktree-session"]
}
```

or, for a checkout, add a local file in `.opencode/plugins/` that re-exports
`../../server.ts` — this repo dogfoods that setup.

Differences from the V1 plugin:

- No branch prompt: each new top-level session automatically gets a worktree
  named from its session slug (opt out with `autoCreate: false`, or create one
  on demand with the `createworktree` tool).
- Worktrees are managed through the built-in V2 worktree service; only the
  exit commit/push shells out to git (the V2 API has no commit).
- Exit commit, matching V1: when a session ends (or `deleteworktree` runs),
  pending changes are staged, committed as `chore(opencode): session snapshot`
  and pushed to `origin` before the worktree is removed. If the commit or push
  fails, the worktree is kept so nothing is lost. `autoCleanup: false` skips
  the exit cleanup entirely, `forceRemove` forces removal, and the
  `deleteworktree` tool moves the session back to the main checkout first
  (its `force` input skips the commit and discards changes).
- Uses the same config file, including `postWorktree` (settable at runtime with
  the `setpostworktree` tool).

## Workflow

1. **Start Session:** Run `opencode`.
2. **Branch Prompt:** You will be prompted for a branch suffix (e.g., `feature-xyz`).
3. **Worktree Creation:** The plugin creates `opencode/feature-xyz` and moves the session into that path.
4. **Execution:** The AI performs tasks inside the isolated worktree.
5. **Exit:** Upon closing the session, the plugin:

- Stages all changes.
- Generates a commit message via OpenCode API.
- Pushes to `origin`.
- Removes the worktree safely.

### Demo Videos

**Creating a Worktree**
  
https://github.com/user-attachments/assets/58e59a3e-80eb-4877-b5c9-ae8b9f93e816

**Deleting a Worktree**
  
https://github.com/user-attachments/assets/f30a8329-f8d0-4c8d-9785-5101cff67b9d



## Requirements

- Node.js runtime
- Git installed and configured in PATH
- OpenCode CLI

## Config

Example (save as `.opencode/opencode-worktree-session-config.json`):

```json
{
  "terminal": {
    "mode": "custom",
    "bin": "alacritty",
    "args": "",
    "workingDirectoryArgument": "--working-directory",
    "commandFlag": "-e"
  },
  "postWorktree": {
    "cmd": "webstorm",
    "args": ""
  },
  "configToolsAvailable": false
}
```

Configure the plugin in `.opencode/opencode-worktree-session-config.json`.

- `terminal` — Controls how the plugin launches a terminal.
  - `mode` — launch mode: `default` | `custom` | `specific`
  - `bin` — terminal binary
  - `args` — extra args
  - `workingDirectoryArgument` — workdir flag
  - `commandFlag` — command flag
  - `terminal` (specific mode) — `Alacritty`, `iTerm`, `iTerm2`, `Terminal`

- `postWorktree` — Command run after worktree creation.
  - `cmd` — command to run
  - `args` — command args

- `configToolsAvailable` — Enable or disable config helper tools (affects `setpostworktree`, `setworktreesync`, `setterminal`).
  - `boolean` — true/false

Note: change `configToolsAvailable` and restart your OpenCode session for it to take effect.

## Development

- `bun run typecheck` - TypeScript type checking
- `bun run lint` - Fix linting issues
- `bun run format` - Format code with Prettier
- `bun run test` - Run tests
- `bun run build` - Build the plugin

## License

Apache License 2.0
