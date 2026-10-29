// OpenAI Secure MCP Tunnel copy for the Web settings panel: the same codes, labels and
// links as the VS Code settings page (packages/vscode/src/configPanel.ts). That file is
// loaded standalone by its tests, so it keeps its own table; test/openai-copy.test.mjs
// fails when the two drift. Pure data: no DOM imports.

/** Runtime validator in tunnel-client: `tunnel_` + 32 lowercase hex characters. */
export const OPENAI_TUNNEL_ID = /^tunnel_[0-9a-f]{32}$/;

/** OpenAI onboarding pages (developers.openai.com secure-mcp-tunnels guide). */
export const OPENAI_LINK_URLS = {
  platform: 'https://platform.openai.com/settings/organization/tunnels',
  chatgpt: 'https://chatgpt.com/plugins',
} as const;

/** Fixed daemon codes → copy; anything else falls back to the daemon's own reason text. */
export const OPENAI_ERRORS: Record<string, string> = {
  openai_tunnel_unsupported: '当前 daemon 不支持 OpenAI 渠道；请重启 daemon 以加载新版本。',
  openai_tunnel_unavailable: '当前 daemon 不支持 OpenAI 渠道；请重启 daemon 以加载新版本。',
  unsaved_settings: 'Tunnel ID 或 tunnel-client 路径有未保存的修改；请先点击保存。',
  empty_api_key: '请先输入 Runtime API Key。',
  invalid_api_key: 'Runtime API Key 格式不正确（8–1024 个可见字符，不能含空格）。',
  settings_changed: '设置刚刚发生变化；请重试。',
  settings_changed_elsewhere: 'Tunnel ID 或 tunnel-client 路径刚在别处（如 Web 设置页）修改，已显示最新值；请确认后再启动。',
  revision_conflict: '设置刚刚发生变化；请重试。',
  settings_unavailable: 'daemon 设置暂不可用；请稍后重试。',
  credential_changed: '密钥刚刚在别处被修改；请重试。',
  already_running: 'OpenAI 渠道正以不同的配置运行；请先停止再启动。',
  run_changed: '渠道已被其他窗口重新启动；请刷新状态后重试。',
  daemon_changed: 'daemon 已重启；请重试。',
  cancelled: '启动已被取消。',
  native_loopback_required: '请求被拒绝：仅允许本机扩展调用。',
  local_only: '请求被拒绝：只能在这台电脑的浏览器里操作 OpenAI 渠道。',
  credential_store_unavailable: '无法读写本机保存的 Runtime API Key。',
  credential_store_timeout: '读写 Runtime API Key 超时；请稍后重试。',
  credential_store_failed: '保存 Runtime API Key 失败；密钥状态已重新读取。',
  credential_delete_unconfirmed: '无法确认密钥已删除；请稍后重试。',
};

/** Status → [tone, label]; tone is '', 'ok', 'warn' or 'bad'. */
export const OPENAI_STATUS_LABELS: Record<string, readonly [string, string]> = {
  off: ['', '未启动'],
  starting: ['warn', '启动中…'],
  ready: ['ok', '就绪'],
  recovering: ['warn', '恢复中…'],
  stopping: ['warn', '停止中…'],
  error: ['bad', '已停止（出错）'],
  unavailable: ['bad', '不可用'],
};
