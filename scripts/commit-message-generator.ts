/**
 * 提交信息生成器
 * 优先使用 LLM 分析变更；不可用时按规则生成
 */

import { HumanMessage } from '@langchain/core/messages';
import { isBinaryArtifact } from './git-utils';
import { verifyLlmConnectivity } from './llm-connectivity';
import { isLlmConfigured, llm, logger } from './shim';

export type GitChangeStatus = {
  modified: string[];
  added: string[];
  deleted: string[];
  untracked: string[];
};

export type CommitMessageResult = {
  message: string;
  source: 'ai' | 'rules';
  rulesReason?:
    | 'no-key'
    | 'binary-only'
    | 'binary-mixed'
    | 'fast-mode'
    | 'ai-unreachable'
    | 'ai-timeout'
    | 'ai-error';
};

function allChangedFiles(status: GitChangeStatus): string[] {
  return [
    ...status.modified,
    ...status.added,
    ...status.deleted,
    ...status.untracked,
  ];
}

function shouldUseAi(status: GitChangeStatus): { use: boolean; reason?: CommitMessageResult['rulesReason'] } {
  if (process.env.MYGIT_NO_AI === '1' || process.env.MYGIT_FAST_RULES === '1') {
    return { use: false, reason: 'fast-mode' };
  }
  if (!isLlmConfigured()) {
    return { use: false, reason: 'no-key' };
  }
  const files = allChangedFiles(status);
  if (files.length > 0 && files.every((f) => isBinaryArtifact(f))) {
    return { use: false, reason: 'binary-only' };
  }
  const hasBinary = files.some((f) => isBinaryArtifact(f));
  if (hasBinary && process.env.MYGIT_FORCE_AI !== '1') {
    return { use: false, reason: 'binary-mixed' };
  }
  return { use: true };
}

function aiTimeoutMs(): number {
  const parsed = Number.parseInt(process.env.MYGIT_AI_TIMEOUT_MS ?? '15000', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 15000;
}

async function invokeLlm(prompt: string): Promise<string> {
  const ms = aiTimeoutMs();
  const response = await Promise.race([
    llm.invoke([new HumanMessage(prompt)]),
    new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error(`AI 请求超时（${ms}ms）`)), ms);
    }),
  ]);
  return response.content.toString();
}

export async function generateCommitMessage(
  status: GitChangeStatus,
  diff: string,
): Promise<CommitMessageResult> {
  const aiDecision = shouldUseAi(status);
  if (!aiDecision.use) {
    const reason = aiDecision.reason ?? 'no-key';
    const hints: Record<NonNullable<CommitMessageResult['rulesReason']>, string> = {
      'no-key': '未配置有效 DASHSCOPE_API_KEY',
      'binary-only': '变更均为 PDF/ZIP 等二进制文件',
      'binary-mixed': '含 PDF/ZIP 等二进制（设 MYGIT_FORCE_AI=1 可强制 AI）',
      'fast-mode': 'MYGIT_NO_AI 或 MYGIT_FAST_RULES 已启用',
      'ai-unreachable': 'AI 连接验证失败',
      'ai-timeout': 'AI 请求超时',
      'ai-error': 'AI 调用失败',
    };
    logger.info(`使用规则生成提交信息（${hints[reason]}）`);
    return {
      message: generateFallbackCommitMessage(status),
      source: 'rules',
      rulesReason: reason,
    };
  }

  const connectivity = await verifyLlmConnectivity();
  if (!connectivity.ok) {
    const detail = connectivity.error ?? '无法连接 LLM API';
    logger.warn('AI 连接不可用，跳过 AI 生成', { error: detail });
    return {
      message: generateFallbackCommitMessage(status),
      source: 'rules',
      rulesReason: 'ai-unreachable',
    };
  }

  try {
    const ms = aiTimeoutMs();
    logger.info(`开始生成提交信息（AI，超时 ${ms}ms）...`);
    console.log(`⏳ 等待 AI 响应（最多 ${Math.round(ms / 1000)}s）...`);
    const prompt = buildPrompt(status, diff);
    const started = Date.now();
    const content = await invokeLlm(prompt);
    const commitMessage = extractCommitMessage(content);
    logger.info('提交信息生成成功', {
      length: commitMessage.length,
      source: 'ai',
      elapsedMs: Date.now() - started,
    });
    return { message: commitMessage, source: 'ai' };
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error);
    const reason: CommitMessageResult['rulesReason'] = errMsg.includes('超时')
      ? 'ai-timeout'
      : 'ai-error';
    logger.warn('AI 生成提交信息失败，回退到规则生成', { error: errMsg });
    console.warn(`⚠️  ${errMsg}，改用规则生成提交信息`);
    return {
      message: generateFallbackCommitMessage(status),
      source: 'rules',
      rulesReason: reason,
    };
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
  return `${title}\n\n${details.join('\n')}`;
}

function inferCommitType(files: string[]): string {
  const joined = files.join(' ').toLowerCase();
  if (/\.(md|mdx|pdf|pptx?)$|(^|\/)docs?\//.test(joined)) return 'docs';
  if (/\.(test|spec)\.(ts|tsx|js|jsx)$|(^|\/)tests?\/|test_.*\.py|.*_test\.py/.test(joined))
    return 'test';
  if (/fix|bug|hotfix/.test(joined)) return 'fix';
  if (/\.(ts|tsx|js|jsx|py)$/.test(joined)) return 'feat';
  if (
    /package\.json|bun\.lock|pyproject\.toml|poetry\.lock|requirements\.txt|\.gitignore|\.env|tsconfig/.test(joined)
  ) {
    return 'chore';
  }
  if (/^scripts\//.test(joined)) return 'chore';
  return 'chore';
}

function inferScope(files: string[]): string | null {
  const scopes = new Set<string>();
  for (const file of files) {
    const normalized = file.replace(/\\/g, '/');
    if (normalized.startsWith('google/')) {
      scopes.add('google');
    } else if (normalized.startsWith('examples/')) {
      scopes.add('examples');
    } else if (normalized.startsWith('skills/')) {
      scopes.add('skills');
    } else if (normalized.startsWith('scripts/')) {
      scopes.add('scripts');
    } else if (normalized.startsWith('.agents/') || normalized.startsWith('.agent/')) {
      scopes.add('agents');
    }
  }
  if (scopes.size === 1) return [...scopes][0];
  if (scopes.size > 1) return 'sdk';
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
  return parts.join('，') || '更新项目文件';
}

function formatFileList(files: string[], max = 6): string {
  const trimmed = files.map((f) => f.trim());
  if (trimmed.length <= max) return trimmed.join(', ');
  return `${trimmed.slice(0, max).join(', ')} 等 ${trimmed.length} 个`;
}

function buildPrompt(status: GitChangeStatus, diff: string): string {
  const filesSummary = [];

  if (status.added.length > 0) {
    filesSummary.push(`新增文件: ${status.added.join(', ')}`);
  }
  if (status.modified.length > 0) {
    filesSummary.push(`修改文件: ${status.modified.join(', ')}`);
  }
  if (status.deleted.length > 0) {
    filesSummary.push(`删除文件: ${status.deleted.join(', ')}`);
  }
  if (status.untracked.length > 0) {
    filesSummary.push(`未跟踪文件: ${status.untracked.join(', ')}`);
  }

  const maxDiffLength = 3000;
  const truncatedDiff =
    diff.length > maxDiffLength
      ? diff.substring(0, maxDiffLength) + '\n...(内容已截断)'
      : diff;

  return `你是一个专业的 Git 提交信息生成助手，熟悉 Python 代码、Markdown 文档与脚本变更。请根据以下变更信息生成清晰、简洁的中文提交信息。

## 文件变更概况
${filesSummary.join('\n')}

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
  message = message.replace(/^```[a-z]*\n/i, '');
  message = message.replace(/\n```$/i, '');

  const lines = message.split('\n');
  const filteredLines = lines.filter((line) => {
    const lower = line.toLowerCase();
    return (
      !lower.startsWith('提交信息:') &&
      !lower.startsWith('commit message:') &&
      !lower.startsWith('以下是') &&
      !lower.startsWith('here is')
    );
  });

  return filteredLines.join('\n').trim();
}
