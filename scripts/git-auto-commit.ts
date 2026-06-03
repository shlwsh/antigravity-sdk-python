/**
 * Git 自动提交脚本
 * 自动检测变更、生成提交信息并推送到远程仓库
 */

import { logger } from "./shim";
import {
  isGitRepository,
  getGitStatus,
  getStagedGitDiff,
  gitAdd,
  gitCommit,
  gitPush,
  getRemoteInfo,
  hasUnpushedCommits,
} from "./git-utils";
import { generateCommitMessage } from "./commit-message-generator";

async function main() {
  logger.info("=".repeat(60));
  logger.info("Git 自动提交工具启动");
  logger.info("=".repeat(60));

  try {
    logger.info("检查 Git 仓库...");
    const isRepo = await isGitRepository();
    if (!isRepo) {
      logger.error("当前目录不是 Git 仓库");
      console.error("❌ 错误: 当前目录不是 Git 仓库");
      process.exit(1);
    }
    logger.debug("Git 仓库检查通过");

    logger.info("获取 Git 状态...");
    const status = await getGitStatus();

    if (!status.hasChanges) {
      const hasUnpushed = await hasUnpushedCommits();
      if (hasUnpushed) {
        logger.info("工作区无变更，但检测到本地有未推送的提交，执行推送流程...");
        console.log("ℹ️ 工作区是干净的，但本地有尚未推送的提交，正在同步推送到远程仓库...\n");
        
        logger.info("获取远程仓库信息...");
        const remotes = await getRemoteInfo();

        if (remotes.length === 0) {
          logger.warn("未配置远程仓库");
          console.log("⚠️  未配置远程仓库,跳过推送步骤");
        } else {
          const remote = remotes[0];
          logger.info("推送到远程仓库", { remote: remote.name, url: remote.url });
          console.log(`🚀 正在推送到远程仓库 ${remote.name}...`);

          await gitPush(remote.name);

          logger.info("推送成功");
          console.log("✅ 代码已成功推送到远程仓库\n");
        }
        return;
      }

      logger.info("没有需要提交的变更且已与远程同步");
      console.log("✅ 工作区是干净的，且本地提交已与远程仓库完全同步。");
      return;
    }

    logger.info("检测到文件变更", {
      modified: status.modified.length,
      added: status.added.length,
      deleted: status.deleted.length,
      untracked: status.untracked.length,
    });

    console.log("\n📝 检测到以下变更:");
    if (status.modified.length > 0) {
      console.log(`  修改: ${status.modified.join(", ")}`);
    }
    if (status.added.length > 0) {
      console.log(`  新增: ${status.added.join(", ")}`);
    }
    if (status.deleted.length > 0) {
      console.log(`  删除: ${status.deleted.join(", ")}`);
    }
    if (status.untracked.length > 0) {
      console.log(`  未跟踪: ${status.untracked.join(", ")}`);
    }
    if (status.excluded.length > 0) {
      console.log(`  已跳过 (logs/): ${status.excluded.join(", ")}`);
    }
    console.log();

    logger.info("添加文件到暂存区...");
    await gitAdd();
    logger.debug("文件已添加到暂存区");

    logger.info("获取变更差异...");
    const diff = await getStagedGitDiff();
    logger.debug("差异获取完成", { diffLength: diff.length });

    console.log("🤖 正在生成提交信息...\n");
    const { message: commitMessage, source } = await generateCommitMessage(
      status,
      diff,
    );

    const sourceLabel =
      source === "ai" ? "AI 生成" : "规则生成（未配置或 AI 不可用）";
    console.log(`📋 生成的提交信息 (${sourceLabel}):`);
    console.log("─".repeat(50));
    console.log(commitMessage);
    console.log("─".repeat(50));
    console.log();

    logger.info("提交代码...");
    await gitCommit(commitMessage);
    logger.info("代码提交成功");
    console.log("✅ 代码已提交到本地仓库\n");

    logger.info("获取远程仓库信息...");
    const remotes = await getRemoteInfo();

    if (remotes.length === 0) {
      logger.warn("未配置远程仓库");
      console.log("⚠️  未配置远程仓库,跳过推送步骤");
    } else {
      const remote = remotes[0];
      logger.info("推送到远程仓库", { remote: remote.name, url: remote.url });
      console.log(`🚀 正在推送到远程仓库 ${remote.name}...`);

      await gitPush(remote.name);

      logger.info("推送成功");
      console.log("✅ 代码已推送到远程仓库\n");
    }

    logger.info("=".repeat(60));
    logger.info("Git 自动提交完成");
    logger.info("=".repeat(60));
  } catch (error) {
    logger.error("执行失败", {
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });

    console.error(
      "\n❌ 执行失败:",
      error instanceof Error ? error.message : String(error),
    );
    process.exit(1);
  }
}

main();
