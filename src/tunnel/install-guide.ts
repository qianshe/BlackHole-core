export const CHANNEL_GUIDE_URL='https://blackhole.stellarbridge.dpdns.org/#channels';
export function cloudflaredInstallHint(platform:string=process.platform):string {
 const install=platform==='darwin'?'在终端运行 brew install cloudflared，或使用 Cloudflare 官方 macOS 下载页'
  :platform==='linux'?'按 Linux 发行版使用 Cloudflare 官方软件源或下载页安装 cloudflared'
  :platform==='win32'?'从 Cloudflare 官方 Windows 下载页安装 cloudflared，并加入 PATH'
  :'从 Cloudflare 官方下载页选择对应系统的 cloudflared';
 return `请在 BlackHole 设置 → 公网渠道 → Cloudflare 点击「一键初始化安装」，由你明确触发 PATH 验证或固定版本下载并回填路径；初始化不会启动公网渠道。也可以手动处理：${install}，再填写可执行文件的完整路径。手动修改 PATH 后请重启 VS Code 和 BlackHole 本地服务。本地功能不受影响。配置指导：${CHANNEL_GUIDE_URL}`;
}
