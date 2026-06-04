#!/usr/bin/env python3
"""AI Git 提交工具：自动 add → commit → push（适配 WSL2 + Windows 代理/凭据）"""

import json
import os
import socket
import subprocess
import sys
from datetime import datetime
import requests

WIN_GIT = "/mnt/c/Program Files/Git/cmd/git.exe"
GCM_WRAPPER = os.path.join(os.path.dirname(__file__), "git-credential-gcm.sh")
PROXY_PORTS = ("7897", "7890", "10809", "1080")
def run_command(command, check=True, env=None):
    result = subprocess.run(
        command,
        shell=True,
        capture_output=True,
        text=True,
        env=env,
    )
    if check and result.returncode != 0:
        return None
    return result.stdout.strip()


def load_env_file(path):
    config = {}
    if not os.path.exists(path):
        return config
    with open(path, "r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, value = line.split("=", 1)
            config[key.strip()] = value.strip().strip("'").strip('"')
    return config


def is_port_open(host, port, timeout=0.8):
    try:
        with socket.create_connection((host, int(port)), timeout=timeout):
            return True
    except OSError:
        return False


def resolve_proxy(config):
    """解析可用 HTTP 代理。WSL2 下 127.0.0.1 常已映射到宿主机代理端口。"""
    explicit = (
        config.get("MYGIT_HTTP_PROXY")
        or config.get("https_proxy")
        or config.get("HTTPS_PROXY")
        or config.get("http_proxy")
        or config.get("HTTP_PROXY")
        or os.environ.get("MYGIT_HTTP_PROXY")
        or os.environ.get("https_proxy")
        or os.environ.get("HTTPS_PROXY")
    )
    if explicit:
        explicit = explicit.rstrip("/")
        if "://" not in explicit:
            explicit = f"http://{explicit}"
        # 简单解析 host:port
        body = explicit.split("://", 1)[1]
        host = body.split(":")[0].split("/")[0]
        port = 7897
        if ":" in body.split("/")[0]:
            port = int(body.split(":")[1].split("/")[0])
        if is_port_open(host, port):
            return f"http://{host}:{port}"

    for port in PROXY_PORTS:
        if is_port_open("127.0.0.1", port):
            return f"http://127.0.0.1:{port}"

    # 备用：/etc/resolv.conf 中的 nameserver（非 TUN Fake-IP 时）
    try:
        with open("/etc/resolv.conf", encoding="utf-8") as f:
            for line in f:
                if line.startswith("nameserver"):
                    host = line.split()[1]
                    if host.startswith("198.18."):
                        continue
                    for port in PROXY_PORTS:
                        if is_port_open(host, port):
                            return f"http://{host}:{port}"
    except OSError:
        pass
    return None


def apply_proxy_env(env, proxy_url):
    if not proxy_url:
        return env
    for key in (
        "http_proxy",
        "https_proxy",
        "HTTP_PROXY",
        "HTTPS_PROXY",
        "all_proxy",
        "ALL_PROXY",
    ):
        env[key] = proxy_url
    return env


def clear_proxy_env(env):
    for key in (
        "http_proxy",
        "https_proxy",
        "HTTP_PROXY",
        "HTTPS_PROXY",
        "all_proxy",
        "ALL_PROXY",
    ):
        env.pop(key, None)
    return env


def clean_env_for_windows_git():
    """Windows Git 推送时剥离 WSL 代理/SSL 相关变量，避免 TLS handshake 失败。"""
    skip_substrings = ("proxy", "PROXY", "SSL", "CURL", "GIT_SSL", "GIT_HTTP")
    cleaned = {}
    for key, value in os.environ.items():
        if any(part in key for part in skip_substrings):
            continue
        cleaned[key] = value
    return cleaned


def call_dashscope_api(session, url, headers, payload, proxy_url):
    """DashScope：优先代理（WSL 直连常超时），再尝试直连。"""
    attempts = []
    if proxy_url:
        p = {"http": proxy_url, "https": proxy_url}
        attempts.append(p)
    attempts.append({"http": None, "https": None})

    last_error = None
    for proxies in attempts:
        try:
            resp = session.post(url, headers=headers, json=payload, timeout=60, proxies=proxies)
            resp.raise_for_status()
            return resp
        except (requests.RequestException, OSError) as exc:
            last_error = exc
    raise last_error


def git_executable_for_push():
    """优先使用 Windows Git（复用 Windows 凭据与网络栈，避免 WSL TLS/认证问题）。"""
    if os.path.isfile(WIN_GIT):
        return WIN_GIT
    return "git"


def build_git_push_env(base_env, proxy_url, github_token):
    env = base_env.copy()
    if github_token:
        # PAT 模式：显式凭据，不依赖交互
        apply_proxy_env(env, proxy_url)
        env["GIT_TERMINAL_PROMPT"] = "0"
        return env, ["-c", f"credential.helper=!f() {{ echo username=x-access-token; echo password={github_token}; }}; f"]

    # 无 PAT：用 Windows Git（使用精简环境，避免 WSL 代理变量干扰 TLS）
    if os.path.isfile(WIN_GIT):
        return clean_env_for_windows_git(), []

    apply_proxy_env(env, proxy_url)
    env["GIT_TERMINAL_PROMPT"] = "0"
    extra = ["-c", "http.version=HTTP/1.1"]
    if os.path.isfile(GCM_WRAPPER):
        extra.extend(["-c", f"credential.helper=!{GCM_WRAPPER}"])
    return env, extra


def run_git(args, env=None, check=True):
    cmd = ["git"] + args
    result = subprocess.run(cmd, capture_output=True, text=True, env=env)
    if check and result.returncode != 0:
        stderr = result.stderr.strip() or result.stdout.strip()
        raise RuntimeError(stderr or f"git {' '.join(args)} failed")
    return result


def main():
    print("🚀 AI Git 提交工具启动 (Python 优化版)")

    workspace = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    os.chdir(workspace)

    env_file = ".env.mygit"
    if not os.path.exists(env_file):
        print(f"❌ 错误: 找不到配置文件 {env_file}")
        print("请复制 .agent/skills/mygit/resources/env.mygit.template 并填写配置")
        sys.exit(1)

    config = load_env_file(env_file)
    api_key = config.get("DASHSCOPE_API_KEY")
    base_url = config.get("DASHSCOPE_BASE_URL", "").rstrip("/")
    model = config.get("DASHSCOPE_MODEL")
    github_token = config.get("GITHUB_TOKEN") or config.get("GH_TOKEN")

    if not all([api_key, base_url, model]):
        print("❌ 错误: 配置缺少 DASHSCOPE_API_KEY / DASHSCOPE_BASE_URL / DASHSCOPE_MODEL")
        sys.exit(1)

    proxy_url = resolve_proxy(config)
    if proxy_url:
        print(f"📡 使用代理: {proxy_url}")
    else:
        print("📡 未检测到本地代理端口，将尝试直连")

    if run_command("git rev-parse --git-dir") is None:
        print("❌ 错误: 当前目录不是 Git 仓库")
        sys.exit(1)

    print("📝 正在检查代码变更...")
    status_output = run_command("git status --porcelain")
    if not status_output:
        print("✅ 没有检测到代码变更")
        sys.exit(0)

    changes = status_output.split("\n")
    print(f"发现 {len(changes)} 个文件变更：")
    for line in changes:
        print(f"  {line}")

    version_files = ["package.xml", "CMakeLists.txt", "package.json", "pyproject.toml"]
    if any(any(vf in line for vf in version_files) for line in changes):
        print("\n⚠️ 检测到版本或构建配置文件变更，建议确认是否需要更新版本号。")

    print("\n🤖 正在使用 AI 生成提交信息...")
    commit_msg = ""
    subprocess.run("git add .", shell=True, check=True)
    diff_content = run_command("git diff --cached") or ""

    try:
        if len(diff_content) > 15000:
            diff_content = diff_content[:15000] + "\n... (Diff truncated)"

        headers = {
            "Content-Type": "application/json",
            "Authorization": f"Bearer {api_key}",
        }
        payload = {
            "model": model,
            "messages": [
                {
                    "role": "system",
                    "content": (
                        "你是一个专业的 Git 提交信息生成助手。请根据代码变更生成简洁、清晰的中文提交信息。\n"
                        "规范：第一行使用 Conventional Commits 前缀（feat/fix/docs/chore 等），"
                        "不超过 50 字；使用中文；不要 Markdown 代码块或多余解释。"
                    ),
                },
                {
                    "role": "user",
                    "content": f"变更摘要:\n{status_output}\n\n变更详情:\n{diff_content}",
                },
            ],
            "max_tokens": 500,
            "temperature": 0.7,
        }

        session = requests.Session()
        resp = call_dashscope_api(
            session,
            f"{base_url}/chat/completions",
            headers,
            payload,
            proxy_url,
        )
        commit_msg = resp.json()["choices"][0]["message"]["content"].strip()
        if commit_msg.startswith("```"):
            lines = commit_msg.split("\n")
            if lines[0].startswith("```"):
                lines = lines[1:]
            if lines and lines[-1].strip() == "```":
                lines = lines[:-1]
            commit_msg = "\n".join(lines).strip()

    except Exception as e:
        print(f"⚠️ AI 生成提交信息失败 ({e})，正在使用托底逻辑...")
        today = datetime.now().strftime("%Y-%m-%d")
        commit_msg = (
            f"chore: 自动同步代码变更 ({today})\n\n"
            f"变更摘要：\n{status_output}\n\n"
            "由于 AI 生成失败，此信息由系统自动生成。"
        )

    print("\n提交信息：")
    print("──────────────────────────────────────────────────")
    print(commit_msg)
    print("──────────────────────────────────────────────────\n")

    print("💾 正在创建提交...")
    msg_file = os.path.join(".git", "COMMIT_MSG_TMP")
    with open(msg_file, "w", encoding="utf-8") as f:
        f.write(commit_msg)
    try:
        run_git(["commit", "-F", msg_file, "--no-verify"])
    except RuntimeError as e:
        if "nothing to commit" in str(e).lower():
            print("✅ 没有新的变更需要提交")
            sys.exit(0)
        print(f"❌ 提交失败: {e}")
        sys.exit(1)
    finally:
        if os.path.exists(msg_file):
            os.remove(msg_file)

    print("🚀 正在推送到远程仓库...")
    branch = run_command("git rev-parse --abbrev-ref HEAD")
    remote = run_command(f"git config branch.{branch}.remote") or "origin"
    has_upstream = run_command(f"git config branch.{branch}.merge")

    git_bin = git_executable_for_push()
    if git_bin != "git":
        print("🔐 使用 Windows Git 推送（复用 Windows 凭据，推荐 WSL 环境）")
    elif github_token:
        print("🔐 使用 GITHUB_TOKEN 推送")
    elif not os.path.isfile(WIN_GIT):
        print("⚠️ 未找到 Windows Git，将尝试 WSL Git + 代理/GCM")
        print("   建议在 .env.mygit 中配置 GITHUB_TOKEN，或安装 Windows Git")

    push_env, extra_git_args = build_git_push_env(os.environ, proxy_url, github_token)
    push_cmd = [git_bin] + extra_git_args
    if has_upstream:
        push_cmd += ["push", "--no-verify"]
        print(f"📡 远程仓库: {remote}, 分支: {branch}")
    else:
        push_cmd += ["push", "--set-upstream", remote, branch, "--no-verify"]
        print(f"📡 远程仓库: {remote}, 分支: {branch} (首次推送)")

    result = subprocess.run(push_cmd, env=push_env, text=True, capture_output=True)
    if result.returncode != 0:
        err = (result.stderr or result.stdout).strip()
        print(f"\n❌ 推送失败: {err}")
        print("本地提交已保留。可尝试：")
        print("  1) 在 .env.mygit 添加 GITHUB_TOKEN=<GitHub PAT>")
        print("  2) 手动执行: '/mnt/c/Program Files/Git/cmd/git.exe' push")
        sys.exit(1)

    out = (result.stdout or result.stderr).strip()
    if out:
        print(out)
    print("\n✨ 提交并推送成功！")


if __name__ == "__main__":
    main()
