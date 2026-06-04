/**
 * 单独验证 mygit 使用的 LLM API 是否可达
 * 用法: bun run mygit:check-ai
 */

import { verifyLlmConnectivity } from './llm-connectivity';
import { getLlmBaseUrl, getLlmModelName, isLlmConfigured } from './shim';

async function main() {
  console.log('LLM 连接检查 (mygit)');
  console.log('─'.repeat(50));

  if (!isLlmConfigured()) {
    console.error('❌ 未在 .env.mygit 中配置有效的 DASHSCOPE_API_KEY');
    process.exit(1);
  }

  console.log(`  Base URL: ${getLlmBaseUrl()}`);
  console.log(`  Model:    ${getLlmModelName()}`);
  console.log('─'.repeat(50));

  const result = await verifyLlmConnectivity({ force: true });
  if (result.ok) {
    const via = result.viaProxy ? '经代理' : '直连';
    console.log(`\n✅ 连接成功（${via}，${result.latencyMs ?? '?'}ms）`);
    process.exit(0);
  }

  console.error(`\n❌ 连接失败: ${result.error ?? '未知错误'}`);
  if (result.statusCode) {
    console.error(`   HTTP 状态码: ${result.statusCode}`);
  }
  process.exit(1);
}

main();
