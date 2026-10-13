// Dual-contract entry: opencode v1 and v2 from one module.
//
// - opencode v1 validates `{ id, server }` where `server()` returns v1 Hooks.
// - opencode v2.0+ validates `{ id, setup }`.
//
// v2 resolves this file for both install shapes:
//   - package install: package.json `exports["./server"]` / `exports["."]`
//   - directory install: Bun.resolveSync("<dir>/server") -> <dir>/server.ts
//
// The v1 implementation lives in v1/ and imports
// `@opencode-ai/plugin`, which opencode v2 does not provide, so it is imported
// lazily inside `server()` and never enters the module graph on v2.
// v2/server.ts stays free of `@opencode/plugin` value imports for the same
// reason in the other direction (`import type` is erased at build time).
import type { Hooks, PluginInput } from '@opencode-ai/plugin';
import { id, setup } from './v2/server';

export { id, setup };

async function server(input: PluginInput): Promise<Hooks> {
  const { GitWorktreeSessionPlugin } = await import('./v1/opencode-worktree-session.ts');
  return GitWorktreeSessionPlugin(input);
}

export default {
  id,
  server,
  setup,
};
