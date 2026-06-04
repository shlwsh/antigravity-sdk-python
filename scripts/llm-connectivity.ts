/**
 * LLM API 连通性探测（提交前预检，失败则 mygit 不调用 AI）
 */

import { getLlmApiKey, getLlmBaseUrl, getLlmModelName, llmHttpProxy, logger } from './shim';

export type LlmConnectivityResult = {
  ok: boolean;
  latencyMs?: number;
  viaProxy?: boolean;
  error?: string;
  statusCode?: number;
};

let cachedProbe: { result: LlmConnectivityResult; at: number } | null = null;

function probeCacheTtlMs(): number {
  const parsed = Number.parseInt(process.env.MYGIT_AI_PROBE_CACHE_MS ?? '60000', 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 60000;
}

function probeTimeoutMs(): number {
  const parsed = Number.parseInt(
    process.env.MYGIT_AI_PROBE_TIMEOUT_MS ?? '8000',
    10,
  );
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 8000;
}

function chatCompletionsUrl(): string {
  const base = getLlmBaseUrl().replace(/\/$/, '');
  return `${base}/chat/completions`;
}

function buildProbeBody(): string {
  return JSON.stringify({
    model: getLlmModelName(),
    messages: [{ role: 'user', content: 'ping' }],
    max_tokens: 1,
    temperature: 0,
  });
}

function buildHeaders(): Record<string, string> {
  const key = getLlmApiKey();
  if (!key) {
    throw new Error('未配置 API Key');
  }
  return {
    Authorization: `Bearer ${key}`,
    'Content-Type': 'application/json',
  };
}

async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function fetchInit(useProxy: boolean): RequestInit {
  const headers = buildHeaders();
  const body = buildProbeBody();
  if (useProxy && llmHttpProxy) {
    return {
      method: 'POST',
      headers,
      body,
      proxy: llmHttpProxy,
    } as RequestInit;
  }
  return { method: 'POST', headers, body };
}

function formatProbeError(err: unknown, statusCode?: number): string {
  if (err instanceof Error) {
    if (err.name === 'AbortError') {
      return `连接超时（${probeTimeoutMs()}ms）`;
    }
    return err.message;
  }
  if (statusCode === 401) return 'API Key 无效或未授权（401）';
  if (statusCode === 403) return 'API 访问被拒绝（403）';
  if (statusCode === 429) return 'API 请求过于频繁（429）';
  if (statusCode && statusCode >= 500) return `API 服务端错误（${statusCode}）`;
  return String(err);
}

async function probeOnce(useProxy: boolean): Promise<LlmConnectivityResult> {
  const url = chatCompletionsUrl();
  const timeoutMs = probeTimeoutMs();
  const started = Date.now();

  try {
    const response = await fetchWithTimeout(
      url,
      fetchInit(useProxy),
      timeoutMs,
    );
    const latencyMs = Date.now() - started;

    if (response.ok) {
      return { ok: true, latencyMs, viaProxy: useProxy && Boolean(llmHttpProxy) };
    }

    let detail = response.statusText;
    try {
      const json = (await response.json()) as { error?: { message?: string } };
      detail = json.error?.message ?? detail;
    } catch {
      // ignore parse errors
    }

    return {
      ok: false,
      latencyMs,
      viaProxy: useProxy && Boolean(llmHttpProxy),
      statusCode: response.status,
      error: formatProbeError(new Error(detail), response.status),
    };
  } catch (err) {
    return {
      ok: false,
      latencyMs: Date.now() - started,
      viaProxy: useProxy && Boolean(llmHttpProxy),
      error: formatProbeError(err),
    };
  }
}

/**
 * 探测 LLM 是否可达。成功才应调用 AI 生成提交信息。
 * @param options.force 忽略进程内缓存
 * @param options.quiet 不输出控制台进度
 */
export async function verifyLlmConnectivity(options?: {
  force?: boolean;
  quiet?: boolean;
}): Promise<LlmConnectivityResult> {
  if (process.env.MYGIT_SKIP_AI_PROBE === '1') {
    return { ok: true };
  }

  if (!getLlmApiKey()) {
    return { ok: false, error: '未配置有效 API Key' };
  }

  const ttl = probeCacheTtlMs();
  if (!options?.force && cachedProbe && Date.now() - cachedProbe.at < ttl) {
    return cachedProbe.result;
  }

  if (!options?.quiet) {
    console.log('🔌 正在验证 AI 连接...');
  }

  const attempts: boolean[] = llmHttpProxy ? [true, false] : [false];
  let last: LlmConnectivityResult = { ok: false, error: '未尝试连接' };

  for (const useProxy of attempts) {
    last = await probeOnce(useProxy);
    if (last.ok) {
      cachedProbe = { result: last, at: Date.now() };
      if (!options?.quiet) {
        const via = last.viaProxy ? '（经代理）' : '（直连）';
        console.log(
          `✅ AI 连接正常${via}，耗时 ${last.latencyMs ?? '?'}ms`,
        );
      }
      logger.info('AI 连接验证通过', last);
      return last;
    }
    logger.debug('AI 连接探测失败', { useProxy, error: last.error });
  }

  cachedProbe = { result: last, at: Date.now() };
  if (!options?.quiet) {
    console.warn(`⚠️  AI 连接失败: ${last.error ?? '未知错误'}`);
    if (llmHttpProxy) {
      console.warn(
        `   已尝试代理 ${llmHttpProxy} 与直连；请检查密钥、网络或 MYGIT_HTTP_PROXY`,
      );
    }
  }
  logger.warn('AI 连接验证失败', last);
  return last;
}
