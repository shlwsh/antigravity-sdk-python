import { ChatOpenAI } from '@langchain/openai';
import { appendFileSync, mkdirSync } from 'fs';
import * as path from 'path';
import { config } from 'dotenv';
import { getRepoRoot } from './repo-root';

const REPO_ROOT = getRepoRoot();

config({ path: path.join(REPO_ROOT, '.env.mygit') });
config({ path: path.join(REPO_ROOT, '.env') });
config({ path: path.join(REPO_ROOT, '.env.local'), override: true });

/** 仅用于 LLM 请求，不写入 process.env，避免干扰 git push */
export const llmHttpProxy =
  process.env.MYGIT_HTTP_PROXY ||
  process.env.HTTPS_PROXY ||
  process.env.https_proxy;

const LOG_FILE = path.resolve(REPO_ROOT, 'logs', 'app.log');

function writeLog(level: string, msg: string, meta?: unknown) {
  const line = `[${new Date().toISOString()}] [${level}] ${msg}${meta ? ` ${JSON.stringify(meta)}` : ''}\n`;
  try {
    mkdirSync(path.dirname(LOG_FILE), { recursive: true });
    appendFileSync(LOG_FILE, line, 'utf-8');
  } catch {
    // 日志写入失败不影响主流程
  }
}

export const logger = {
  info: (msg: string, meta?: unknown) => {
    console.log(`[INFO] ${msg}`, meta ? JSON.stringify(meta) : '');
    writeLog('INFO', msg, meta);
  },
  debug: (msg: string, meta?: unknown) => {
    writeLog('DEBUG', msg, meta);
  },
  error: (msg: string, meta?: unknown) => {
    console.error(`[ERROR] ${msg}`, meta ? JSON.stringify(meta) : '');
    writeLog('ERROR', msg, meta);
  },
  warn: (msg: string, meta?: unknown) => {
    console.warn(`[WARN] ${msg}`, meta ? JSON.stringify(meta) : '');
    writeLog('WARN', msg, meta);
  },
};

const PLACEHOLDER_API_KEYS = new Set([
  '',
  'your-api-key-here',
  'sk-your-api-key',
  'sk-你的密钥',
  'changeme',
]);

/** 是否已配置可用于生成提交信息的 LLM API Key */
export function isLlmConfigured(): boolean {
  return Boolean(getLlmApiKey());
}

export function getLlmApiKey(): string | undefined {
  const key = (
    process.env.DASHSCOPE_API_KEY ||
    process.env.OPENAI_API_KEY ||
    ''
  ).trim();
  return PLACEHOLDER_API_KEYS.has(key) ? undefined : key;
}

export function getLlmModelName(): string {
  return (
    process.env.DASHSCOPE_MODEL ||
    process.env.OPENAI_API_MODEL ||
    process.env.MODEL_NAME ||
    'gpt-3.5-turbo'
  );
}

export function getLlmBaseUrl(): string {
  const raw =
    process.env.DASHSCOPE_BASE_URL ||
    process.env.OPENAI_API_BASE ||
    process.env.OPENAI_BASE_URL ||
    'https://dashscope.aliyuncs.com/compatible-mode/v1';
  return raw.replace(/\/$/, '');
}

const llmTemperature = Number.parseFloat(
  process.env.LLM_TEMPERATURE ?? '0.1',
);
const requestTimeoutMs = Number.parseInt(
  process.env.REQUEST_TIMEOUT ?? process.env.MYGIT_AI_TIMEOUT_MS ?? '20000',
  10,
);

export const llm = new ChatOpenAI({
  modelName: getLlmModelName(),
  temperature: Number.isFinite(llmTemperature) ? llmTemperature : 0.1,
  timeout: Number.isFinite(requestTimeoutMs) ? requestTimeoutMs : 60000,
  apiKey: getLlmApiKey(),
  configuration: {
    baseURL: getLlmBaseUrl(),
    ...(llmHttpProxy
      ? {
          fetch: (url, init) =>
            fetch(url, { ...init, proxy: llmHttpProxy } as RequestInit),
        }
      : {}),
  },
});
