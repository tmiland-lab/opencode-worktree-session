// opencode v2 plugin: automatic git worktree sessions.
//
// v2 ships a native worktree service (`ctx.worktree`) and movable sessions
// (`ctx.session.move`), so the full lifecycle is server-side:
//
//   session.created -> create a worktree, move the session into it
//   session.execution.started -> self-heal sessions whose created event was
//                      missed while the daemon was still booting
//   session.deleted -> commit + push pending changes, remove the worktree
//                      (kept when the commit or push fails)
//
// The v2 worktree service checks out a detached HEAD, so each fresh worktree
// gets an `opencode/<name>` branch before the session moves in; exit commits
// land on that branch and push to `origin`.
//
// Diagnostics: ~/.local/share/opencode/worktree-session.log
//
// Worktrees are managed through the v2 worktree service; only the exit
// commit/push shells out to git. No terminal spawning: clients follow the
// moved session.
// The v1 implementation stays at v1/opencode-worktree-session.ts.
//
// Config: <canonical checkout>/.opencode/opencode-worktree-session-config.json
//   autoCreate           (default true)  isolate every new top-level session
//   autoCleanup          (default true)  on session end commit + push changes, then remove the worktree
//   forceRemove          (default false) force-remove the worktree during exit cleanup
//   postWorktree         { cmd, args }   command to run inside a fresh worktree
//   configToolsAvailable (default true)  register the setpostworktree tool
//
// Env overrides: OPENCODE_POST_CMD, OPENCODE_POST_CMD_ARGS.

import type { Plugin } from '@opencode/plugin';
import { spawn } from 'node:child_process';
import { appendFileSync, existsSync, statSync, truncateSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';

export const id = 'opencode-worktree-session';

const CONFIG_FILE = '.opencode/opencode-worktree-session-config.json';
const LOG = '[worktree-session]';
const LOG_FILE = join(homedir(), '.local', 'share', 'opencode', 'worktree-session.log');
const LOG_MAX_BYTES = 1_000_000;
const BRANCH_PREFIX = 'opencode/';
// session.created can be missed while the daemon boots; a later update event
// self-heals the session when it was created within this grace window.
const SELF_HEAL_EVENTS = new Set([
  'session.execution.started',
  'session.usage.updated',
  'session.instructions.updated',
]);
const SELF_HEAL_GRACE_MS = 60_000;

type PostWorktree = { cmd: string; args?: string };
type Config = {
  autoCreate?: boolean;
  autoCleanup?: boolean;
  forceRemove?: boolean;
  postWorktree?: PostWorktree;
  configToolsAvailable?: boolean;
};
type Entry = { directory: string; name?: string; createdAt: number };
type Index = Record<string, Entry>;
type SessionInfo = {
  parentID?: string;
  title?: string;
  time?: { created?: number };
  location?: { directory?: string };
};

const log = (message: string) => {
  console.log(`${LOG} ${message}`);
  try {
    appendFileSync(LOG_FILE, `[${new Date().toISOString()}] ${message}\n`);
  } catch {
    /* logging must never break the plugin */
  }
};

const normalize = (path: string) => path.replace(/\/+$/, '');

const slugify = (value: string) =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48) || 'session';

const loadConfig = async (canonical: string): Promise<Config> => {
  try {
    return JSON.parse(await readFile(join(canonical, CONFIG_FILE), 'utf8')) as Config;
  } catch {
    return {};
  }
};

const saveConfig = async (canonical: string, config: Config) => {
  const path = join(canonical, CONFIG_FILE);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
};

const runPostWorktree = (config: Config, worktreeDirectory: string) => {
  const fromEnv = Boolean(process.env.OPENCODE_POST_CMD);
  const cmd = process.env.OPENCODE_POST_CMD ?? config.postWorktree?.cmd;
  if (!cmd) return;
  const rawArgs = fromEnv
    ? (process.env.OPENCODE_POST_CMD_ARGS ?? '')
    : (config.postWorktree?.args ?? '');
  const args = [...(rawArgs.trim() ? rawArgs.trim().split(/\s+/) : []), worktreeDirectory];
  try {
    spawn(cmd, args, { cwd: worktreeDirectory, detached: true, stdio: 'ignore' }).unref();
    log(`postWorktree: ${cmd} ${args.join(' ')}`);
  } catch (error) {
    log(`postWorktree failed: ${String(error)}`);
  }
};

const worktreePrompt = (directory: string, canonical: string) =>
  [
    'WORKTREE SESSION (STRICT):',
    `This session works in an isolated git worktree at ${directory}.`,
    'The main checkout stays untouched; commit your work on this branch.',
    '1) When the task is finished, run the `deleteworktree` tool (ask the user first if there are uncommitted changes worth keeping).',
    '2) After `deleteworktree` succeeds: STOP. Do not run shell commands, read files, or call other tools — the worktree directory is gone.',
    `3) If verification is still needed, ask the user to run it from the main checkout (${canonical}).`,
  ].join('\n');

const canonicalPrompt =
  'A `createworktree` tool is available: it creates an isolated git worktree and moves this session into it, keeping the main checkout clean. Suggest it when the user starts feature work or mentions a branch.';

const GIT_COMMIT_MESSAGE = 'chore(opencode): session snapshot';

const git = (directory: string, args: string[]): Promise<string> =>
  new Promise((resolve, reject) => {
    const child = spawn('git', args, { cwd: directory, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (data) => (stdout += String(data)));
    child.stderr?.on('data', (data) => (stderr += String(data)));
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) {
        resolve(stdout.trim());
      } else {
        const detail = stderr.trim() || stdout.trim() || `exit code ${code}`;
        reject(new Error(`git ${args.join(' ')} failed: ${detail}`));
      }
    });
  });

// The v2 worktree service checks out a detached HEAD; attach the session
// branch so exit commits land on it and can be pushed.
const ensureBranch = async (directory: string, name: string): Promise<string> => {
  const current = await git(directory, ['branch', '--show-current']);
  if (current) return current;
  const branch = `${BRANCH_PREFIX}${name}`;
  try {
    await git(directory, ['switch', '-c', branch]);
  } catch {
    await git(directory, ['switch', branch]);
  }
  return branch;
};

const hasChanges = async (directory: string): Promise<boolean> => {
  const status = await git(directory, ['status', '--porcelain']);
  return status.length > 0;
};

// Exit behavior matching the v1 plugin: stage everything, commit, push the branch.
const commitAndPush = async (directory: string, name?: string) => {
  const branch = name
    ? await ensureBranch(directory, name)
    : await git(directory, ['branch', '--show-current']);
  if (!branch) throw new Error('detached HEAD: cannot push the worktree branch');
  await git(directory, ['add', '-A']);
  await git(directory, ['commit', '-m', GIT_COMMIT_MESSAGE]);
  await git(directory, ['push', '-u', 'origin', branch]);
};

export const setup = async (ctx: Plugin.Context) => {
  const projectID = ctx.location.project.id;
  const canonical = ctx.location.project.canonical;
  const here = ctx.location.directory;
  const inWorktree = normalize(here) !== normalize(canonical);
  const indexKey = `worktree-session/index/${projectID}`;
  const releasedKey = (sessionID: string) => `worktree-session/released/${projectID}/${sessionID}`;
  const startedAt = Date.now();

  try {
    if (statSync(LOG_FILE).size > LOG_MAX_BYTES) truncateSync(LOG_FILE, 0);
  } catch {
    /* missing log file is fine */
  }

  let config = await loadConfig(canonical);

  const readIndex = async (): Promise<Index> => {
    const raw = (await ctx.storage.get(indexKey)) as Index | undefined;
    return raw ?? {};
  };

  const writeIndex = async (index: Index) => {
    await ctx.storage.set(indexKey, index);
  };

  const track = async (sessionID: string, entry: Entry) => {
    const index = await readIndex();
    index[sessionID] = entry;
    await writeIndex(index);
  };

  const untrack = async (sessionID: string) => {
    const index = await readIndex();
    if (sessionID in index) {
      delete index[sessionID];
      await writeIndex(index);
    }
  };

  // Claim the tracking entry first so that multiple plugin instances cannot
  // clean up the same worktree twice.
  const claim = async (sessionID: string): Promise<Entry | undefined> => {
    const index = await readIndex();
    const entry = index[sessionID];
    if (!entry) return undefined;
    delete index[sessionID];
    await writeIndex(index);
    return entry;
  };

  // The daemon also removes worktrees natively when a session directory goes
  // away; a later remove call then fails even though the worktree is gone.
  const removeWorktree = async (directory: string, force: boolean) => {
    try {
      await ctx.worktree.remove({ projectID, directory, force });
    } catch (error) {
      if (existsSync(directory)) throw error;
    }
  };

  // Older runtimes carry the session info on `session.updated`; newer ones
  // emit usage/instructions updates without it, so fetch it on demand.
  const fetchSessionInfo = async (sessionID: string): Promise<SessionInfo | undefined> => {
    try {
      return (await ctx.session.get({ sessionID })) as SessionInfo;
    } catch {
      return undefined;
    }
  };

  const createForSession = async (sessionID: string, name: string): Promise<string> => {
    const info = await ctx.worktree.create({ projectID, name });
    await track(sessionID, { directory: info.directory, name, createdAt: Date.now() });
    try {
      await ensureBranch(info.directory, name);
      await ctx.session.move({ sessionID, directory: info.directory });
    } catch (error) {
      await untrack(sessionID);
      try {
        await ctx.worktree.remove({ projectID, directory: info.directory, force: true });
      } catch {
        /* best-effort cleanup */
      }
      throw error;
    }
    runPostWorktree(config, info.directory);
    return info.directory;
  };

  const contextHook = await ctx.session.hook('context', (event) => {
    try {
      if (inWorktree) {
        event.system.push({ type: 'text', text: worktreePrompt(here, canonical) });
      } else {
        event.system.push({ type: 'text', text: canonicalPrompt });
      }
    } catch (error) {
      log(`context hook skipped: ${String(error)}`);
    }
  });

  let stopped = false;
  const events = ctx.event.subscribe();
  const loop = (async () => {
    try {
      for await (const ev of events) {
        if (stopped) break;
        try {
          const type = (ev as { type?: string }).type;
          const data = ((ev as { data?: unknown }).data ?? {}) as {
            sessionID?: string;
            parentID?: string;
            slug?: string;
            location?: { directory?: string };
            info?: SessionInfo;
          };

          if (type === 'session.created') {
            if (!data.sessionID) continue;
            if (data.parentID) continue;
            if (config.autoCreate === false) continue;
            if (inWorktree) continue;
            // Only the instance whose location owns the new session may isolate
            // it; every plugin instance receives every event.
            if ((data.location?.directory ?? '') !== here) continue;
            const index = await readIndex();
            if (index[data.sessionID]) continue;
            const name = slugify(data.slug ?? data.sessionID);
            try {
              const directory = await createForSession(data.sessionID, name);
              log(`session ${data.sessionID} moved into worktree ${directory} (${name})`);
            } catch (error) {
              log(`worktree for ${data.sessionID} failed: ${String(error)}`);
            }
            continue;
          }

          // session.created can be missed while the daemon is still booting;
          // a follow-up update event self-heals the session into its worktree.
          if (SELF_HEAL_EVENTS.has(type ?? '')) {
            if (inWorktree || config.autoCreate === false) continue;
            if (!data.sessionID) continue;
            const info = data.info ?? (await fetchSessionInfo(data.sessionID));
            if (!info) continue;
            if ((info.location?.directory ?? '') !== here) continue;
            if (info.parentID) continue;
            const created = info.time?.created;
            if (typeof created !== 'number' || created < startedAt - SELF_HEAL_GRACE_MS) continue;
            const index = await readIndex();
            if (index[data.sessionID]) continue;
            if (await ctx.storage.get(releasedKey(data.sessionID))) continue;
            const name = slugify(info.title ?? data.sessionID);
            try {
              const directory = await createForSession(data.sessionID, name);
              log(`session ${data.sessionID} self-healed into worktree ${directory} (${name})`);
            } catch (error) {
              log(`self-heal for ${data.sessionID} failed: ${String(error)}`);
            }
            continue;
          }

          if (type === 'session.deleted') {
            if (!data.sessionID) continue;
            const entry = await claim(data.sessionID);
            if (!entry) continue;
            if (config.autoCleanup === false) {
              log(
                `session ${data.sessionID} ended; keeping worktree ${entry.directory} (autoCleanup=false)`
              );
              continue;
            }
            try {
              if (await hasChanges(entry.directory)) {
                await commitAndPush(entry.directory, entry.name);
                log(`committed & pushed changes in ${entry.directory}`);
              }
              await removeWorktree(entry.directory, config.forceRemove === true);
              log(`removed worktree ${entry.directory}`);
            } catch (error) {
              if (existsSync(entry.directory)) {
                log(`worktree ${entry.directory} kept (cleanup failed): ${String(error)}`);
                await track(data.sessionID, entry);
              } else {
                log(`worktree ${entry.directory} already removed; dropping tracking entry`);
              }
            }
            continue;
          }
        } catch (error) {
          // One bad event must not kill the subscription loop.
          log(`event handling failed: ${String(error)}`);
        }
      }
    } catch (error) {
      if (!stopped) log(`event loop error: ${String(error)}`);
    }
  })();

  try {
    await ctx.tool.transform((editor) => {
      editor.add({
        name: 'createworktree',
        description:
          'Create an isolated git worktree for this session and move the session into it. The main checkout stays untouched. Ask the user for a branch name unless they provided one.',
        input: {
          type: 'object',
          properties: {
            branch: {
              type: 'string',
              description: "Name for the worktree and its branch, e.g. 'feat/login-flow'",
            },
          },
          additionalProperties: false,
        },
        execute: async (input, context) => {
          const sessionID = context.sessionID;
          const index = await readIndex();
          const existing = index[sessionID];
          if (existing)
            return { content: `This session already runs in worktree ${existing.directory}.` };
          const branch = (input as { branch?: string } | undefined)?.branch;
          const name = slugify(branch ?? `session-${String(sessionID).slice(-6)}`);
          try {
            const directory = await createForSession(sessionID, name);
            return {
              content: `Created worktree '${name}' and moved this session to ${directory}. The main checkout is untouched. Use the deleteworktree tool when the task is done.`,
            };
          } catch (error) {
            return { content: `Failed to create worktree: ${String(error)}` };
          }
        },
      });

      editor.add({
        name: 'deleteworktree',
        description:
          'Move this session back to the main checkout, commit and push any changes, and remove its git worktree. With force, skips the commit and discards uncommitted changes. After it succeeds, do not run further shell commands.',
        input: {
          type: 'object',
          properties: {
            force: {
              type: 'boolean',
              description: 'Skip the exit commit and discard uncommitted changes',
            },
          },
          additionalProperties: false,
        },
        execute: async (input, context) => {
          const sessionID = context.sessionID;
          const index = await readIndex();
          const tracked = index[sessionID];
          const directory = tracked?.directory ?? (inWorktree ? here : undefined);
          if (!directory) return { content: 'This session has no worktree to delete.' };
          const force = (input as { force?: boolean } | undefined)?.force === true;
          try {
            if (!force && (await hasChanges(directory))) {
              await commitAndPush(directory, tracked?.name ?? basename(directory));
              log(`committed & pushed changes in ${directory}`);
            }
            if (tracked || inWorktree) {
              await ctx.session.move({ sessionID, directory: canonical });
              if (tracked) await untrack(sessionID);
            }
            await removeWorktree(directory, force);
            // Never re-isolate this session after an explicit worktree delete.
            await ctx.storage.set(releasedKey(sessionID), true);
            return {
              content: `Removed worktree ${directory}. This session now runs in the main checkout (${canonical}). Stop here; do not run further shell commands.`,
            };
          } catch (error) {
            if (tracked && existsSync(directory)) await track(sessionID, tracked);
            return {
              content: `Could not clean up worktree ${directory}: ${String(error)}. Retry with force=true to discard uncommitted changes.`,
            };
          }
        },
      });

      if (config.configToolsAvailable !== false) {
        editor.add({
          name: 'setpostworktree',
          description:
            "Set the command that runs inside each freshly created worktree (e.g. 'pnpm install'). Stored in .opencode/opencode-worktree-session-config.json.",
          input: {
            type: 'object',
            properties: {
              cmd: { type: 'string', description: 'Executable to run in the new worktree' },
              args: { type: 'string', description: 'Space-separated extra arguments' },
              clear: { type: 'boolean', description: 'Remove the configured command' },
            },
            additionalProperties: false,
          },
          execute: async (input) => {
            const options = (input ?? {}) as { cmd?: string; args?: string; clear?: boolean };
            if (options.clear) {
              delete config.postWorktree;
            } else if (options.cmd) {
              config.postWorktree = { cmd: options.cmd, args: options.args };
            }
            await saveConfig(canonical, config);
            return {
              content: config.postWorktree
                ? `postWorktree set: ${`${config.postWorktree.cmd} ${config.postWorktree.args ?? ''}`.trim()}`
                : 'postWorktree cleared.',
            };
          },
        });
      }
    });
  } catch (error) {
    log(`tool registration failed: ${String(error)}`);
  }

  return async () => {
    stopped = true;
    try {
      await contextHook.dispose();
    } catch {
      /* already disposed */
    }
    try {
      const closer = (events as { return?: () => Promise<unknown> }).return;
      if (typeof closer === 'function') await closer.call(events);
    } catch {
      /* stream already closed */
    }
    void loop.catch(() => {});
  };
};

export default { id, setup };
