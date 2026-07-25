import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

import { isInside } from "./worktree.ts";

const exec = promisify(execFile);

export type EvidenceExport = {
  directory: string;
  patchPath: string;
  evidencePath: string;
  checksumsPath: string;
  patchSha256: string;
  evidenceSha256: string;
};

export const EVIDENCE_ARTIFACT_NAMES = [
  "changes.patch",
  "evidence.json",
  "checksums.sha256",
] as const;

export type EvidenceArtifactName = (typeof EVIDENCE_ARTIFACT_NAMES)[number];

export type EvidenceArtifact = {
  filename: EvidenceArtifactName;
  contentType: string;
  content: Buffer;
};

export async function readEvidenceArtifact(input: {
  exportRoot: string;
  exportId: string;
  filename: string;
  maxBytes: number;
}): Promise<EvidenceArtifact> {
  if (!/^[A-Za-z0-9-]+$/.test(input.exportId)) {
    throw new Error("Export id is not safe.");
  }
  if (
    !EVIDENCE_ARTIFACT_NAMES.includes(input.filename as EvidenceArtifactName)
  ) {
    throw new Error("Artifact name is not allowed.");
  }
  const filename = input.filename as EvidenceArtifactName;
  const root = await realpath(resolve(input.exportRoot));
  const directory = await realpath(join(root, input.exportId));
  if (!isInside(root, directory))
    throw new Error("Export path escaped its root.");
  const path = await realpath(join(directory, filename));
  if (!isInside(directory, path))
    throw new Error("Artifact path escaped its export.");
  const metadata = await stat(path);
  if (!metadata.isFile() || metadata.size > input.maxBytes) {
    throw new Error("Artifact is unavailable or exceeds its size limit.");
  }
  return {
    filename,
    contentType:
      filename === "changes.patch"
        ? "text/x-diff; charset=utf-8"
        : filename === "evidence.json"
          ? "application/json; charset=utf-8"
          : "text/plain; charset=utf-8",
    content: await readFile(path),
  };
}

export async function exportEvidencePacket(input: {
  exportRoot: string;
  runId: string;
  cwd: string;
  baseCommit: string | null;
  patch?: string;
  evidence: object;
  patchLimitBytes: number;
}): Promise<EvidenceExport> {
  if (!/^[A-Za-z0-9-]+$/.test(input.runId)) {
    throw new Error("Run id is not safe for export.");
  }
  const configuredRoot = resolve(input.exportRoot);
  await mkdir(configuredRoot, { recursive: true, mode: 0o700 });
  const root = await realpath(configuredRoot);
  const directory = join(root, input.runId);
  if (!isInside(root, directory))
    throw new Error("Export path escaped its root.");
  await mkdir(directory, { mode: 0o700 });

  const patch =
    input.patch ??
    (input.baseCommit
      ? await collectPatch(input.cwd, input.baseCommit, input.patchLimitBytes)
      : "");
  if (Buffer.byteLength(patch) > input.patchLimitBytes) {
    throw new Error(`Patch exceeds ${input.patchLimitBytes} bytes.`);
  }
  const patchPath = join(directory, "changes.patch");
  await writeFile(patchPath, patch, { mode: 0o600 });
  const patchSha256 = sha256(patch);
  const evidenceBody = `${JSON.stringify(
    {
      ...input.evidence,
      artifacts: { patch: "changes.patch", patchSha256 },
    },
    null,
    2,
  )}\n`;
  const evidencePath = join(directory, "evidence.json");
  await writeFile(evidencePath, evidenceBody, { mode: 0o600 });
  const evidenceSha256 = sha256(evidenceBody);
  const checksumsPath = join(directory, "checksums.sha256");
  await writeFile(
    checksumsPath,
    `${patchSha256}  changes.patch\n${evidenceSha256}  evidence.json\n`,
    { mode: 0o600 },
  );
  return {
    directory,
    patchPath,
    evidencePath,
    checksumsPath,
    patchSha256,
    evidenceSha256,
  };
}

export async function collectPatch(
  cwd: string,
  baseCommit: string,
  limit: number,
): Promise<string> {
  let patch = await git(cwd, [
    "diff",
    "--binary",
    "--no-ext-diff",
    baseCommit,
    "--",
  ]);
  const untracked = (
    await git(cwd, ["ls-files", "--others", "--exclude-standard", "-z"])
  )
    .split("\0")
    .filter(Boolean);
  for (const relative of untracked) {
    const target = join(cwd, relative);
    if (!isInside(cwd, target))
      throw new Error("Untracked path escaped worktree.");
    patch += await gitDiffNewFile(cwd, relative);
    if (Buffer.byteLength(patch) > limit) {
      throw new Error(`Patch exceeds ${limit} bytes.`);
    }
  }
  if (Buffer.byteLength(patch) > limit) {
    throw new Error(`Patch exceeds ${limit} bytes.`);
  }
  return patch;
}

async function git(cwd: string, args: string[]): Promise<string> {
  const result = await exec("git", args, {
    cwd,
    encoding: "utf8",
    maxBuffer: 6 * 1024 * 1024,
    timeout: 10_000,
    killSignal: "SIGKILL",
  });
  return result.stdout;
}

async function gitDiffNewFile(cwd: string, relative: string): Promise<string> {
  try {
    return await git(cwd, [
      "diff",
      "--no-index",
      "--binary",
      "--",
      "/dev/null",
      relative,
    ]);
  } catch (error) {
    const result = error as { code?: number; stdout?: string };
    if (result.code === 1 && typeof result.stdout === "string")
      return result.stdout;
    throw error;
  }
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
