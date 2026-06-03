import { ChatOpenAI } from "@langchain/openai";
import { appendFileSync, mkdirSync } from "fs";
import * as path from "path";
import { config } from "dotenv";

config({ path: path.join(process.cwd(), ".env") });
config({ path: path.join(process.cwd(), ".env.local"), override: true });

const LOG_FILE = path.resolve(process.cwd(), "logs", "app.log");

function writeLog(level: string, msg: string, meta?: unknown) {
  const line = `[${new Date().toISOString()}] [${level}] ${msg}${meta ? ` ${JSON.stringify(meta)}` : ""}\n`;
  try {
    mkdirSync(path.dirname(LOG_FILE), { recursive: true });
    appendFileSync(LOG_FILE, line, "utf-8");
  } catch {
    // 日志写入失败不影响主流程
  }
}

export const logger = {
  info: (msg: string, meta?: unknown) => {
    console.log(`[INFO] ${msg}`, meta ? JSON.stringify(meta) : "");
    writeLog("INFO", msg, meta);
  },
  debug: (msg: string, meta?: unknown) => {
    writeLog("DEBUG", msg, meta);
  },
  error: (msg: string, meta?: unknown) => {
    console.error(`[ERROR] ${msg}`, meta ? JSON.stringify(meta) : "");
    writeLog("ERROR", msg, meta);
  },
  warn: (msg: string, meta?: unknown) => {
    console.warn(`[WARN] ${msg}`, meta ? JSON.stringify(meta) : "");
    writeLog("WARN", msg, meta);
  },
};

const PLACEHOLDER_API_KEYS = new Set([
  "",
  "your-api-key-here",
  "sk-your-api-key",
  "changeme",
]);

/** 是否已配置可用于生成提交信息的 LLM API Key */
export function isLlmConfigured(): boolean {
  const key = (
    process.env.DASHSCOPE_API_KEY ||
    process.env.OPENAI_API_KEY ||
    ""
  ).trim();
  return !PLACEHOLDER_API_KEYS.has(key);
}

const llmTemperature = Number.parseFloat(
  process.env.LLM_TEMPERATURE ?? "0.1",
);
const requestTimeoutMs = Number.parseInt(
  process.env.REQUEST_TIMEOUT ?? "60000",
  10,
);

export const llm = new ChatOpenAI({
  modelName:
    process.env.DASHSCOPE_MODEL ||
    process.env.OPENAI_API_MODEL ||
    process.env.MODEL_NAME ||
    "gpt-3.5-turbo",
  temperature: Number.isFinite(llmTemperature) ? llmTemperature : 0.1,
  timeout: Number.isFinite(requestTimeoutMs) ? requestTimeoutMs : 60000,
  apiKey: process.env.DASHSCOPE_API_KEY || process.env.OPENAI_API_KEY,
  configuration: {
    baseURL:
      process.env.DASHSCOPE_BASE_URL ||
      process.env.OPENAI_API_BASE ||
      process.env.OPENAI_BASE_URL,
  },
});
