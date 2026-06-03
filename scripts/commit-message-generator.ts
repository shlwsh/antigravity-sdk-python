/**
 * 提交信息生成器
 * 优先使用 LLM 分析变更；不可用时按规则生成
 */

import { HumanMessage } from "@langchain/core/messages";
import { isLlmConfigured, llm, logger } from "./shim";

export type GitChangeStatus = {
  modified: string[];
  added: string[];
  deleted: string[];
  untracked: string[];
};

export async function generateCommitMessage(
  status: GitChangeStatus,
  diff: string,
): Promise<{ message: string; source: "ai" | "rules" }> {
  if (!isLlmConfigured()) {
    logger.warn("未配置有效 DASHSCOPE_API_KEY 或 OPENAI_API_KEY，使用规则生成提交信息");
    return { message: generateFallbackCommitMessage(status), source: "rules" };
  }

  try {
    logger.info("开始生成提交信息（AI）...");
    const prompt = buildPrompt(status, diff);
    const response = await llm.invoke([new HumanMessage(prompt)]);
    const commitMessage = extractCommitMessage(response.content.toString());
    logger.info("提交信息生成成功", {
      length: commitMessage.length,
      source: "ai",
    });
    return { message: commitMessage, source: "ai" };
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error);
    logger.warn("AI 生成提交信息失败，回退到规则生成", { error: errMsg });
    return { message: generateFallbackCommitMessage(status), source: "rules" };
  }
}

export function generateFallbackCommitMessage(status: GitChangeStatus): string {
  const allFiles = [
    ...status.modified,
    ...status.added,
    ...status.deleted,
    ...status.untracked,
  ]
    .map((f) => f.trim())
    .filter(Boolean);

  const type = inferCommitType(allFiles);
  const scope = inferScope(allFiles);
  const title = scope
    ? `${type}(${scope}): ${summarizeChange(status)}`
    : `${type}: ${summarizeChange(status)}`;

  const details: string[] = [];
  if (status.added.length > 0) {
    details.push(`- 新增: ${formatFileList(status.added)}`);
  }
  if (status.modified.length > 0) {
    details.push(`- 修改: ${formatFileList(status.modified)}`);
  }
  if (status.deleted.length > 0) {
    details.push(`- 删除: ${formatFileList(status.deleted)}`);
  }
  if (status.untracked.length > 0) {
    details.push(`- 未跟踪: ${formatFileList(status.untracked)}`);
  }

  if (details.length === 0) {
    return title;
  }
  return `${title}\n\n${details.join("\n")}`;
}

function inferCommitType(files: string[]): string {
  const joined = files.join(" ").toLowerCase();
  if (/\.(md|mdx|pdf|pptx?)$|(^|\/)docs?\//.test(joined)) return "docs";
  if (/\.(test|spec)\.(ts|tsx|js|jsx)$|(^|\/)tests?\/|test_.*\.py|.*_test\.py/.test(joined))
    return "test";
  if (/fix|bug|hotfix/.test(joined)) return "fix";
  if (/\.(ts|tsx|js|jsx|py)$/.test(joined)) return "feat";
  if (
    /package\.json|bun\.lock|pyproject\.toml|poetry\.lock|requirements\.txt|\.gitignore|\.env|tsconfig/.test(joined)
  ) {
    return "chore";
  }
  if (/^scripts\//.test(joined)) return "chore";
  return "chore";
}

function inferScope(files: string[]): string | null {
  const scopes = new Set<string>();
  for (const file of files) {
    const normalized = file.replace(/\\/g, "/");
    if (normalized.startsWith("google/")) {
      scopes.add("google");
    } else if (normalized.startsWith("examples/")) {
      scopes.add("examples");
    } else if (normalized.startsWith("skills/")) {
      scopes.add("skills");
    } else if (normalized.startsWith("scripts/")) {
      scopes.add("scripts");
    } else if (normalized.startsWith(".agents/")) {
      scopes.add("agents");
    }
  }
  if (scopes.size === 1) return [...scopes][0];
  if (scopes.size > 1) return "sdk";
  return null;
}

function summarizeChange(status: GitChangeStatus): string {
  const parts: string[] = [];
  if (status.added.length > 0)
    parts.push(`新增 ${status.added.length} 个文件`);
  if (status.modified.length > 0)
    parts.push(`修改 ${status.modified.length} 个文件`);
  if (status.deleted.length > 0)
    parts.push(`删除 ${status.deleted.length} 个文件`);
  if (status.untracked.length > 0)
    parts.push(`未跟踪 ${status.untracked.length} 个文件`);
  return parts.join("，") || "更新项目文件";
}

function formatFileList(files: string[], max = 6): string {
  const trimmed = files.map((f) => f.trim());
  if (trimmed.length <= max) return trimmed.join(", ");
  return `${trimmed.slice(0, max).join(", ")} 等 ${trimmed.length} 个`;
}

function buildPrompt(status: GitChangeStatus, diff: string): string {
  const filesSummary = [];

  if (status.added.length > 0) {
    filesSummary.push(`新增文件: ${status.added.join(", ")}`);
  }
  if (status.modified.length > 0) {
    filesSummary.push(`修改文件: ${status.modified.join(", ")}`);
  }
  if (status.deleted.length > 0) {
    filesSummary.push(`删除文件: ${status.deleted.join(", ")}`);
  }
  if (status.untracked.length > 0) {
    filesSummary.push(`未跟踪文件: ${status.untracked.join(", ")}`);
  }

  const maxDiffLength = 3000;
  const truncatedDiff =
    diff.length > maxDiffLength
      ? diff.substring(0, maxDiffLength) + "\n...(内容已截断)"
      : diff;

  return `你是一个专业的 Git 提交信息生成助手，熟悉 Python 代码、Markdown 文档与脚本变更。请根据以下变更信息生成清晰、简洁的中文提交信息。

## 文件变更概况
${filesSummary.join("\n")}

## 变更差异
\`\`\`diff
${truncatedDiff}
\`\`\`

## 要求
1. 使用中文
2. 第一行是简短的标题(不超过50字)
3. 如果需要,可以添加详细说明(空一行后添加)
4. 标题要清晰描述主要变更内容（代码更新、文档调整、测试用例改动等）
5. 使用常见的提交类型前缀(如: feat, fix, docs, style, refactor, test, chore)

请直接输出提交信息,不要添加任何解释或额外内容。`;
}

function extractCommitMessage(content: string): string {
  let message = content.trim();
  message = message.replace(/^```[a-z]*\n/i, "");
  message = message.replace(/\n```$/i, "");

  const lines = message.split("\n");
  const filteredLines = lines.filter((line) => {
    const lower = line.toLowerCase();
    return (
      !lower.startsWith("提交信息:") &&
      !lower.startsWith("commit message:") &&
      !lower.startsWith("以下是") &&
      !lower.startsWith("here is")
    );
  });

  return filteredLines.join("\n").trim();
}
