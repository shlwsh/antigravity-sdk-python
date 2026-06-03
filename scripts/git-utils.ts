/**
 * Git 工具函数模块
 */

import { exec } from "child_process";
import { promisify } from "util";

const execAsync = promisify(exec);

/** mygit 自动提交时排除的路径前缀 */
export const AUTO_COMMIT_EXCLUDE_PREFIXES = ["logs/"] as const;

/** .env、.env.example、.env.local 等环境配置文件（始终纳入提交） */
export function isEnvRelatedFile(filePath: string): boolean {
  const normalized = filePath.replace(/\\/g, "/");
  return /(^|\/)\.env(\.[^/]+)?$/.test(normalized);
}

export function isExcludedFromAutoCommit(filePath: string): boolean {
  if (isEnvRelatedFile(filePath)) return false;
  const normalized = filePath.replace(/\\/g, "/");
  return AUTO_COMMIT_EXCLUDE_PREFIXES.some((prefix) =>
    normalized.startsWith(prefix),
  );
}

/** 内网 Git 远程：推送时绕过本地 HTTP 代理 */
function isInternalGitRemote(url: string): boolean {
  return /\.winning\.com\.cn/i.test(url);
}

async function execGit(
  command: string,
  cwd: string = process.cwd(),
): Promise<string> {
  try {
    const { stdout, stderr } = await execAsync(command, { cwd });
    if (stderr && !stderr.includes("warning")) {
      console.warn("Git 警告:", stderr);
    }
    return stdout.trim();
  } catch (error) {
    throw new Error(
      `Git 命令执行失败: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export async function getGitStatus(): Promise<{
  modified: string[];
  added: string[];
  deleted: string[];
  untracked: string[];
  excluded: string[];
  hasChanges: boolean;
 }> {
  const output = await execGit("git status --porcelain");

  const modified: string[] = [];
  const added: string[] = [];
  const deleted: string[] = [];
  const untracked: string[] = [];
  const excluded: string[] = [];

  if (!output) {
    return { modified, added, deleted, untracked, excluded, hasChanges: false };
  }

  const lines = output.split("\n");
  for (const line of lines) {
    if (!line) continue;

    const status = line.substring(0, 2);
    const file = line.slice(3).trim();

    if (isExcludedFromAutoCommit(file)) {
      excluded.push(file);
      continue;
    }

    if (status.includes("M")) {
      modified.push(file);
    } else if (status.includes("A")) {
      added.push(file);
    } else if (status.includes("D")) {
      deleted.push(file);
    } else if (status === "??") {
      untracked.push(file);
    }
  }

  const hasChanges =
    modified.length > 0 ||
    added.length > 0 ||
    deleted.length > 0 ||
    untracked.length > 0;

  return { modified, added, deleted, untracked, excluded, hasChanges };
}

export async function getGitDiff(files?: string[]): Promise<string> {
  try {
    await execGit("git rev-parse HEAD");
    let command = "git diff --no-ext-diff HEAD";
    if (files && files.length > 0) {
      command += " " + files.join(" ");
    }

    try {
      return await execGit(command);
    } catch {
      console.warn("⚠️  完整 diff 获取失败，使用统计信息代替");
      return await execGit(command.replace("git diff", "git diff --stat"));
    }
  } catch {
    let command = "git diff --no-ext-diff --cached";
    if (files && files.length > 0) {
      command += " " + files.join(" ");
    }

    try {
      return await execGit(command);
    } catch {
      console.warn("⚠️  完整 diff 获取失败，使用统计信息代替");
      return await execGit(command.replace("git diff", "git diff --stat"));
    }
  }
}

export async function getStagedGitDiff(): Promise<string> {
  try {
    return await execGit("git diff --no-ext-diff --cached");
  } catch {
    console.warn("⚠️  完整 diff 获取失败，使用统计信息代替");
    return await execGit("git diff --no-ext-diff --cached --stat");
  }
}

async function stageEnvRelatedFiles(): Promise<void> {
  const output = await execGit("git status --porcelain");
  const envFiles: string[] = [];

  for (const line of output.split("\n")) {
    if (!line) continue;
    const file = line.slice(3).trim();
    if (isEnvRelatedFile(file)) envFiles.push(file);
  }

  if (envFiles.length === 0) return;

  const fileList = envFiles.map((f) => JSON.stringify(f)).join(" ");
  await execGit(`git add -f ${fileList}`);
}

export async function gitAdd(files: string[] = ["."]): Promise<void> {
  if (files.length === 1 && files[0] === ".") {
    await execGit("git add -A");
    for (const prefix of AUTO_COMMIT_EXCLUDE_PREFIXES) {
      try {
        await execGit(`git reset HEAD -- ${prefix}`);
      } catch {
        // 该前缀下无已暂存文件时可忽略
      }
    }
    await stageEnvRelatedFiles();
    return;
  }

  const toAdd = files.filter((f) => !isExcludedFromAutoCommit(f));
  if (toAdd.length === 0) return;

  const fileList = toAdd.map((f) => JSON.stringify(f)).join(" ");
  await execGit(`git add ${fileList}`);
}

export async function gitCommit(message: string): Promise<void> {
  const paragraphs = message
    .split(/\n\n/)
    .map((p) => p.trim())
    .filter(Boolean);

  if (paragraphs.length === 0) {
    throw new Error("提交信息为空");
  }

  const args = paragraphs.map((p) => `-m ${JSON.stringify(p)}`).join(" ");
  await execGit(`git commit ${args}`);
}

export async function gitPush(
  remote: string = "origin",
  branch?: string,
): Promise<void> {
  if (!branch) {
    branch = await execGit("git rev-parse --abbrev-ref HEAD");
  }

  const remotes = await getRemoteInfo();
  const remoteUrl = remotes.find((r) => r.name === remote)?.url ?? "";
  const pushCmd = isInternalGitRemote(remoteUrl)
    ? `git -c http.proxy= -c https.proxy= push ${remote} ${branch}`
    : `git push ${remote} ${branch}`;

  if (isInternalGitRemote(remoteUrl)) {
    console.log("ℹ️  内网远程仓库，推送时绕过本地 HTTP 代理");
  }

  await execGit(pushCmd);
}

export async function getRemoteInfo(): Promise<
  { name: string; url: string }[]
> {
  const output = await execGit("git remote -v");
  const remotes: { name: string; url: string }[] = [];

  const lines = output.split("\n");
  const seen = new Set<string>();

  for (const line of lines) {
    if (!line) continue;
    const parts = line.split(/\s+/);
    if (parts.length >= 2) {
      const key = `${parts[0]}-${parts[1]}`;
      if (!seen.has(key)) {
        seen.add(key);
        remotes.push({ name: parts[0], url: parts[1] });
      }
    }
  }

  return remotes;
}

export async function isGitRepository(): Promise<boolean> {
  try {
    await execGit("git rev-parse --git-dir");
    return true;
  } catch {
    return false;
  }
}

export async function hasUnpushedCommits(): Promise<boolean> {
  try {
    const output = await execGit("git cherry -v");
    return output.trim().length > 0;
  } catch {
    return false;
  }
}
