import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { loadConfig, type SubagentConfig } from "../../src/config.js";

/**
 * Shared isolation helper: every test that touches config-driven directories
 * must route them to a per-test tmpdir. Writing to the real ~/.pi/subagent-*
 * dirs pollutes machine-wide lock/slot/run state and can block real spawns.
 */

export interface IsolatedDirs {
  root: string;
  sessionDir: string;
  worktreeDir: string;
  lockDir: string;
  cleanup: () => Promise<void>;
}

export async function makeIsolatedDirs(prefix = "pi-subagent-test-"): Promise<IsolatedDirs> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  const dirs: IsolatedDirs = {
    root,
    sessionDir: path.join(root, "sessions"),
    worktreeDir: path.join(root, "worktrees"),
    lockDir: path.join(root, "locks"),
    cleanup: () => fs.rm(root, { recursive: true, force: true }),
  };
  await fs.mkdir(dirs.sessionDir, { recursive: true });
  await fs.mkdir(dirs.worktreeDir, { recursive: true });
  await fs.mkdir(dirs.lockDir, { recursive: true });
  return dirs;
}

/** Config with lockDir/sessionDir/worktreeDir ALWAYS pointed at tmp. */
export function makeTestConfig(dirs: IsolatedDirs, overrides: Partial<SubagentConfig> = {}): SubagentConfig {
  return loadConfig(
    {
      sessionDir: dirs.sessionDir,
      worktreeDir: dirs.worktreeDir,
      lockDir: dirs.lockDir,
      ...overrides,
    },
    {},
  );
}

const DIR_ENV_VARS = [
  "PI_SUBAGENT_SESSION_DIR",
  "PI_SUBAGENT_WORKTREE_DIR",
  "PI_SUBAGENT_LOCK_DIR",
] as const;

/**
 * Point the PI_SUBAGENT_*_DIR env vars at isolated dirs (for code paths that
 * build config from env, e.g. the extension's session_start). Returns a
 * restore function.
 */
export function isolateConfigEnv(dirs: IsolatedDirs): () => void {
  const previous = new Map<string, string | undefined>(
    DIR_ENV_VARS.map((name) => [name, process.env[name]]),
  );
  process.env.PI_SUBAGENT_SESSION_DIR = dirs.sessionDir;
  process.env.PI_SUBAGENT_WORKTREE_DIR = dirs.worktreeDir;
  process.env.PI_SUBAGENT_LOCK_DIR = dirs.lockDir;
  return () => {
    for (const name of DIR_ENV_VARS) {
      const value = previous.get(name);
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  };
}
