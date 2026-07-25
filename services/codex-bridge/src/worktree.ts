import { execFile } from "node:child_process";
import { mkdir, realpath } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);

async function git(cwd: string, args: string[]): Promise<string> {
  const result = await exec("git", args, {
    cwd,
    encoding: "utf8",
    maxBuffer: 5 * 1024 * 1024,
  });
  return result.stdout.trim();
}

export type IsolatedWorktree = {
  path: string;
  branch: string;
  baseCommit: string;
};

export class DirtyRepositoryError extends Error {
  readonly code = "dirty_repository";
}

export async function createIsolatedWorktree(
  repo: string,
  runId: string,
  baseRef = "HEAD",
  configuredRoot?: string,
): Promise<IsolatedWorktree> {
  const canonicalRepo = await realpath(repo);
  const topLevel = await realpath(
    await git(canonicalRepo, ["rev-parse", "--show-toplevel"]),
  );
  if (topLevel !== canonicalRepo) {
    throw new Error(`Allowed path is not the repository root: ${repo}`);
  }
  const dirty = (
    await git(canonicalRepo, [
      "status",
      "--porcelain=v1",
      "--untracked-files=all",
    ])
  )
    .split(/\r?\n/)
    .filter((line) => line && !line.startsWith("?? .voiss/"));
  if (dirty.length) {
    throw new DirtyRepositoryError(
      "Repository must be clean before an isolated write run can start.",
    );
  }
  const baseCommit = await git(canonicalRepo, [
    "rev-parse",
    "--verify",
    `${baseRef}^{commit}`,
  ]);
  const root = resolve(
    configuredRoot ?? join(canonicalRepo, ".voiss", "worktrees"),
  );
  await mkdir(root, { recursive: true });
  const path = join(root, runId);
  const branch = `voiss/run-${runId}`;
  await git(canonicalRepo, ["worktree", "add", "-b", branch, path, baseCommit]);
  const canonicalWorktree = await realpath(path);
  const worktreeTopLevel = await realpath(
    await git(canonicalWorktree, ["rev-parse", "--show-toplevel"]),
  );
  if (worktreeTopLevel !== canonicalWorktree) {
    throw new Error("Git created an unexpected worktree root.");
  }
  return { path: canonicalWorktree, branch, baseCommit };
}

export function isInside(root: string, candidate: string): boolean {
  const base = resolve(root);
  const value = resolve(candidate);
  return value === base || value.startsWith(`${base}/`);
}
