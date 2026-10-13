import type { Plugin } from '@opencode/plugin';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout } from 'node:timers';
import { afterEach, describe, expect, it } from 'vitest';
import plugin from './server.ts';

const SESSION_SNAPSHOT = 'chore(opencode): session snapshot';
const WORKTREES_DIR = join('.opencode', 'worktrees');

type Repo = { root: string; canonical: string; remote: string };

// Parameter names below document the mock contract for each hook.
/* eslint-disable no-unused-vars */
type Tool = {
  name: string;
  execute: (
    _input: Record<string, unknown>,
    _context: { sessionID: string }
  ) => Promise<{ content: string }>;
};

type ContextEvent = { system: Array<{ type: string; text: string }> };

type Harness = {
  canonical: string;
  moves: Array<{ sessionID: string; directory: string }>;
  storage: Map<string, unknown>;
  tools: Map<string, Tool>;
  contextCallbacks: Array<ContextHook>;
  emit: (_event: unknown) => void;
  cleanup: () => Promise<void>;
};

type ToolEditor = { add: (tool: Tool) => void };

type ContextHook = (_event: ContextEvent) => void;

type TransformFn = (_editor: ToolEditor) => void;
/* eslint-enable no-unused-vars */

const git = (cwd: string, args: string[]): string =>
  execFileSync('git', args, { cwd, encoding: 'utf8' });

const tryGit = (cwd: string, args: string[]): string | null => {
  try {
    return git(cwd, args);
  } catch {
    return null;
  }
};

const waitFor = async (predicate: () => boolean, timeout = 5000): Promise<void> => {
  const deadline = Date.now() + timeout;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('timed out waiting for condition');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
};

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const createRepo = async (): Promise<Repo> => {
  const root = await mkdtemp(join(tmpdir(), 'wts-v2-'));
  const canonical = join(root, 'project');
  const remote = join(root, 'remote.git');
  mkdirSync(canonical, { recursive: true });
  git(root, ['init', '--bare', 'remote.git']);
  git(canonical, ['init', '-b', 'main']);
  git(canonical, ['config', 'user.email', 'test@example.com']);
  git(canonical, ['config', 'user.name', 'Worktree Test']);
  writeFileSync(join(canonical, 'base.txt'), 'base\n');
  git(canonical, ['add', '.']);
  git(canonical, ['commit', '-m', 'init']);
  git(canonical, ['remote', 'add', 'origin', remote]);
  git(canonical, ['push', '-u', 'origin', 'main']);
  return { root, canonical, remote };
};

const writeConfig = (canonical: string, config: Record<string, unknown>): void => {
  mkdirSync(join(canonical, '.opencode'), { recursive: true });
  writeFileSync(
    join(canonical, '.opencode', 'opencode-worktree-session-config.json'),
    JSON.stringify(config)
  );
};

const createStream = () => {
  const queue: unknown[] = [];
  let wake: (() => void) | null = null;
  let closed = false;
  const iterable = {
    [Symbol.asyncIterator]: () => ({
      next: async (): Promise<IteratorResult<unknown>> => {
        while (queue.length === 0 && !closed) {
          await new Promise<void>((resolve) => {
            wake = resolve;
          });
        }
        if (queue.length === 0) return { done: true, value: undefined };
        return { done: false, value: queue.shift() };
      },
    }),
    return: async (): Promise<IteratorResult<unknown>> => {
      closed = true;
      wake?.();
      return { done: true, value: undefined };
    },
  };
  const emit = (event: unknown): void => {
    queue.push(event);
    wake?.();
    wake = null;
  };
  return { iterable, emit };
};

const startPlugin = async (
  canonical: string,
  options: { config?: Record<string, unknown>; directory?: string } = {}
): Promise<Harness> => {
  if (options.config) writeConfig(canonical, options.config);
  const here = options.directory ?? canonical;
  const storage = new Map<string, unknown>();
  const moves: Harness['moves'] = [];
  const tools = new Map<string, Tool>();
  const contextCallbacks: Harness['contextCallbacks'] = [];
  const stream = createStream();

  const ctx = {
    location: { directory: here, project: { id: 'proj_test', canonical } },
    storage: {
      get: (key: string) => Promise.resolve(storage.get(key)),
      set: (key: string, value: unknown) => {
        storage.set(key, value);
        return Promise.resolve();
      },
    },
    session: {
      move: (input: { sessionID: string; directory: string }) => {
        moves.push(input);
        return Promise.resolve();
      },
      hook: (_name: string, callback: ContextHook) => {
        contextCallbacks.push(callback);
        return Promise.resolve({ dispose: () => Promise.resolve() });
      },
    },
    worktree: {
      // The v2 daemon checks out a detached HEAD, not a branch.
      create: ({ name }: { name: string }) => {
        const directory = join(canonical, WORKTREES_DIR, name);
        git(canonical, ['worktree', 'add', '--detach', directory]);
        return Promise.resolve({ directory });
      },
      remove: ({ directory, force }: { directory: string; force?: boolean }) => {
        git(canonical, ['worktree', 'remove', ...(force ? ['--force'] : []), directory]);
        return Promise.resolve();
      },
    },
    tool: {
      transform: (fn: TransformFn) => {
        fn({ add: (tool) => tools.set(tool.name, tool) });
        return Promise.resolve();
      },
    },
    event: { subscribe: () => stream.iterable },
  };

  const cleanup = await plugin.setup(ctx as unknown as Plugin.Context);
  return { canonical, moves, storage, tools, contextCallbacks, emit: stream.emit, cleanup };
};

const createdEvent = (sessionID: string, slug: string, directory: string): unknown => ({
  type: 'session.created',
  data: { sessionID, slug, location: { directory } },
});

const deletedEvent = (sessionID: string): unknown => ({
  type: 'session.deleted',
  data: { sessionID },
});

const executionStartedEvent = (
  sessionID: string,
  title: string,
  directory: string,
  created?: number
): unknown => ({
  type: 'session.execution.started',
  data: {
    sessionID,
    info: { location: { directory }, title, time: { created: created ?? Date.now() } },
  },
});

const storageHas = (harness: Harness, value: string): boolean =>
  JSON.stringify([...harness.storage.values()]).includes(value);

const remoteBranch = (repo: Repo, name: string): string | null =>
  tryGit(repo.remote, ['rev-parse', '--verify', '--quiet', `refs/heads/opencode/${name}`]);

const repos: Repo[] = [];
const harnesses: Harness[] = [];

const useRepo = async (): Promise<Repo> => {
  const repo = await createRepo();
  repos.push(repo);
  return repo;
};

const usePlugin = async (
  repo: Repo,
  options?: { config?: Record<string, unknown>; directory?: string }
): Promise<Harness> => {
  const harness = await startPlugin(repo.canonical, options);
  harnesses.push(harness);
  return harness;
};

afterEach(async () => {
  await Promise.all(harnesses.splice(0).map((harness) => harness.cleanup()));
  await Promise.all(repos.splice(0).map((repo) => rm(repo.root, { recursive: true, force: true })));
});

describe('worktree lifecycle', () => {
  it('creates a worktree and moves the session on session.created', async () => {
    const repo = await useRepo();
    const harness = await usePlugin(repo);

    harness.emit(createdEvent('ses_a', 'Feature One', repo.canonical));

    await waitFor(() => harness.moves.length === 1);
    const directory = join(repo.canonical, WORKTREES_DIR, 'feature-one');
    expect(harness.moves[0]).toEqual({ sessionID: 'ses_a', directory });
    expect(existsSync(directory)).toBe(true);
    expect(git(repo.canonical, ['worktree', 'list'])).toContain('opencode/feature-one');
    expect(storageHas(harness, 'ses_a')).toBe(true);
  });

  it('ignores sessions from other locations', async () => {
    const repo = await useRepo();
    const harness = await usePlugin(repo);

    harness.emit(createdEvent('ses_other', 'other', join(repo.root, 'elsewhere')));
    await sleep(200);

    expect(harness.moves).toHaveLength(0);
  });

  it('does not create worktrees when autoCreate is disabled', async () => {
    const repo = await useRepo();
    const harness = await usePlugin(repo, { config: { autoCreate: false } });

    harness.emit(createdEvent('ses_noauto', 'noauto', repo.canonical));
    await sleep(200);

    expect(harness.moves).toHaveLength(0);
    expect(existsSync(join(repo.canonical, WORKTREES_DIR))).toBe(false);
  });

  it('commits and pushes changes when the session ends', async () => {
    const repo = await useRepo();
    const harness = await usePlugin(repo);
    harness.emit(createdEvent('ses_b', 'exit-commit', repo.canonical));
    await waitFor(() => harness.moves.length === 1);
    const directory = harness.moves[0].directory;
    writeFileSync(join(directory, 'change.txt'), 'change\n');

    harness.emit(deletedEvent('ses_b'));

    await waitFor(() => remoteBranch(repo, 'exit-commit') !== null);
    expect(git(repo.remote, ['log', '-1', '--format=%s', 'opencode/exit-commit']).trim()).toBe(
      SESSION_SNAPSHOT
    );
    expect(git(repo.remote, ['show', 'opencode/exit-commit:change.txt'])).toBe('change\n');
    await waitFor(() => !existsSync(directory));
    expect(git(repo.canonical, ['worktree', 'list'])).not.toContain('exit-commit');
    expect(storageHas(harness, 'ses_b')).toBe(false);
  });

  it('removes a clean worktree without a snapshot commit', async () => {
    const repo = await useRepo();
    const harness = await usePlugin(repo);
    harness.emit(createdEvent('ses_c', 'clean-exit', repo.canonical));
    await waitFor(() => harness.moves.length === 1);
    const directory = harness.moves[0].directory;

    harness.emit(deletedEvent('ses_c'));

    await waitFor(() => !existsSync(directory));
    expect(remoteBranch(repo, 'clean-exit')).toBeNull();
    expect(storageHas(harness, 'ses_c')).toBe(false);
  });

  it('keeps the worktree tracked when the snapshot push fails', async () => {
    const repo = await useRepo();
    const harness = await usePlugin(repo);
    harness.emit(createdEvent('ses_d', 'push-fail', repo.canonical));
    await waitFor(() => harness.moves.length === 1);
    const directory = harness.moves[0].directory;
    writeFileSync(join(directory, 'change.txt'), 'change\n');
    git(repo.canonical, ['remote', 'set-url', 'origin', join(repo.root, 'missing.git')]);

    harness.emit(deletedEvent('ses_d'));

    await waitFor(
      () => (tryGit(directory, ['log', '-1', '--format=%s']) ?? '').trim() === SESSION_SNAPSHOT
    );
    await waitFor(() => storageHas(harness, 'ses_d'));
    expect(existsSync(directory)).toBe(true);
  });

  it('keeps the worktree when autoCleanup is disabled', async () => {
    const repo = await useRepo();
    const harness = await usePlugin(repo, { config: { autoCleanup: false } });
    harness.emit(createdEvent('ses_keep', 'keep-worktree', repo.canonical));
    await waitFor(() => harness.moves.length === 1);
    const directory = harness.moves[0].directory;

    harness.emit(deletedEvent('ses_keep'));
    await waitFor(() => !storageHas(harness, 'ses_keep'));

    expect(existsSync(directory)).toBe(true);
    expect(remoteBranch(repo, 'keep-worktree')).toBeNull();
  });
});

describe('tools', () => {
  it('createworktree creates a worktree from a branch name', async () => {
    const repo = await useRepo();
    const harness = await usePlugin(repo);

    const tool = harness.tools.get('createworktree');
    expect(tool).toBeDefined();
    const result = await tool!.execute({ branch: 'Manual Branch' }, { sessionID: 'ses_tool' });

    expect(result.content).toContain("Created worktree 'manual-branch'");
    expect(harness.moves[0]).toEqual({
      sessionID: 'ses_tool',
      directory: join(repo.canonical, WORKTREES_DIR, 'manual-branch'),
    });
  });

  it('deleteworktree commits, moves the session back, and removes the worktree', async () => {
    const repo = await useRepo();
    const harness = await usePlugin(repo);
    harness.emit(createdEvent('ses_e', 'tool-exit', repo.canonical));
    await waitFor(() => harness.moves.length === 1);
    const directory = harness.moves[0].directory;
    writeFileSync(join(directory, 'change.txt'), 'change\n');

    const tool = harness.tools.get('deleteworktree');
    expect(tool).toBeDefined();
    const result = await tool!.execute({}, { sessionID: 'ses_e' });

    expect(result.content).toContain('Removed worktree');
    expect(harness.moves[1]).toEqual({ sessionID: 'ses_e', directory: repo.canonical });
    await waitFor(() => remoteBranch(repo, 'tool-exit') !== null);
    expect(existsSync(directory)).toBe(false);
    expect(storageHas(harness, 'ses_e')).toBe(false);
  });

  it('deleteworktree with force skips the snapshot commit', async () => {
    const repo = await useRepo();
    const harness = await usePlugin(repo);
    harness.emit(createdEvent('ses_f', 'tool-force', repo.canonical));
    await waitFor(() => harness.moves.length === 1);
    const directory = harness.moves[0].directory;
    writeFileSync(join(directory, 'change.txt'), 'change\n');

    const tool = harness.tools.get('deleteworktree');
    expect(tool).toBeDefined();
    await tool!.execute({ force: true }, { sessionID: 'ses_f' });

    await waitFor(() => !existsSync(directory));
    expect(remoteBranch(repo, 'tool-force')).toBeNull();
    expect(harness.moves[1]).toEqual({ sessionID: 'ses_f', directory: repo.canonical });
  });
});

describe('context hook', () => {
  it('injects the canonical prompt outside a worktree', async () => {
    const repo = await useRepo();
    const harness = await usePlugin(repo);

    const event: ContextEvent = { system: [] };
    await harness.contextCallbacks[0]?.(event);

    expect(event.system).toHaveLength(1);
    expect(event.system[0].text).toContain('createworktree');
  });

  it('injects the worktree prompt inside a worktree', async () => {
    const repo = await useRepo();
    const harness = await usePlugin(repo, {
      directory: join(repo.canonical, WORKTREES_DIR, 'somewhere'),
    });

    const event: ContextEvent = { system: [] };
    await harness.contextCallbacks[0]?.(event);

    expect(event.system).toHaveLength(1);
    expect(event.system[0].text).toContain('WORKTREE SESSION');
  });
});

describe('robustness', () => {
  it('attaches the opencode/<name> branch inside the daemon worktree', async () => {
    const repo = await useRepo();
    const harness = await usePlugin(repo);
    const directory = join(repo.canonical, WORKTREES_DIR, 'feature-branch');

    harness.emit(createdEvent('ses_branch', 'feature-branch', repo.canonical));

    await waitFor(() => harness.moves.length === 1);
    expect(git(directory, ['branch', '--show-current']).trim()).toBe('opencode/feature-branch');
  });

  it('self-heals a session whose created event was missed', async () => {
    const repo = await useRepo();
    const harness = await usePlugin(repo);

    harness.emit(executionStartedEvent('ses_heal', 'heal-me', repo.canonical));

    await waitFor(() => harness.moves.length === 1);
    expect(harness.moves[0]).toEqual({
      sessionID: 'ses_heal',
      directory: join(repo.canonical, WORKTREES_DIR, 'heal-me'),
    });
  });

  it('does not self-heal sessions created before the plugin started', async () => {
    const repo = await useRepo();
    const harness = await usePlugin(repo);

    harness.emit(
      executionStartedEvent('ses_old', 'old-session', repo.canonical, Date.now() - 600_000)
    );
    await sleep(300);

    expect(harness.moves).toHaveLength(0);
  });

  it('does not re-isolate a session after an explicit worktree delete', async () => {
    const repo = await useRepo();
    const harness = await usePlugin(repo);
    const directory = join(repo.canonical, WORKTREES_DIR, 'released');
    const tool = harness.tools.get('deleteworktree');

    harness.emit(createdEvent('ses_release', 'released', repo.canonical));
    await waitFor(() => harness.moves.length === 1);
    const result = await tool!.execute({}, { sessionID: 'ses_release' });
    expect(result.content).toContain('Removed worktree');
    harness.emit(executionStartedEvent('ses_release', 'released', repo.canonical));
    await sleep(300);

    expect(harness.moves).toHaveLength(2);
    expect(existsSync(directory)).toBe(false);
  });

  it('drops tracking when the worktree was already removed', async () => {
    const repo = await useRepo();
    const harness = await usePlugin(repo);
    const directory = join(repo.canonical, WORKTREES_DIR, 'already-gone');

    harness.emit(createdEvent('ses_gone', 'already-gone', repo.canonical));
    await waitFor(() => harness.moves.length === 1);
    git(repo.canonical, ['worktree', 'remove', '--force', directory]);
    harness.emit(deletedEvent('ses_gone'));
    await sleep(300);

    expect(storageHas(harness, 'ses_gone')).toBe(false);
    expect(git(repo.canonical, ['worktree', 'list'])).not.toContain('already-gone');
  });
});
