/**
 * proxy 域类型。铁律（docs/plan/mcp-proxy-plan.md §2.1）：
 * 不向其他 BlackHole 层泄漏 @modelcontextprotocol/sdk 的具体类型——
 * 本文件（及整个 src/proxy/）只描述 BlackHole 自己的稳定契约。
 */

/** stdio 自 M1；http（StreamableHTTP）自 M4——同一 transport 形状不变（plan §11）。 */
export type ProxyTransport = 'stdio' | 'http';

/** session = 每 session 独立 child；shared = 全局一个 child（M3 浏览器决策用）。 */
export type ProxyScope = 'session' | 'shared';

export type ProxyPrewarm = 'never' | 'on_session_start';

/** BlackHole 自己的 allow/confirm/deny；上游 annotation 永远只是 hint（plan §G4）。 */
export type ProxyRiskDecision = 'allow' | 'confirm' | 'deny';

/** 审批单元层级（plan §7.3）：tool 级默认；args 级给 evaluate_script/fill 类工具。 */
export type ProxyApprovalUnitLevel = 'tool' | 'args';

export interface ProxyLimits {
  /** 连接/握手/listTools 超时，独立于调用超时（plan §8.4）。 */
  connectTimeoutMs: number;
  /** 单次 upstream call 上限；超时 → status=timeout + 副作用未知 hint。 */
  callTimeoutMs: number;
  /** 审批等待上限；超时 → denied 并释放队列（plan §7.3）。 */
  approvalTimeoutMs: number;
  /** daemon 级 upstream child 总数上限；超限新 call → unavailable。 */
  maxChildren: number;
}

/** plan §15.1-13/14 的默认值；per-server limits 可覆盖。 */
export const DEFAULT_PROXY_LIMITS: ProxyLimits = {
  connectTimeoutMs: 15_000,
  callTimeoutMs: 120_000,
  approvalTimeoutMs: 300_000,
  maxChildren: 8,
};

/** plan §15.1-14 的大小上限默认值（字节，除 description 为字符数）。 */
export const PROXY_CAPS = {
  /** argsJson 64KB。 */
  argsJsonBytes: 64 * 1024,
  /** optionsJson 与 argsJson 同上限（同为输入 JSON 串）。 */
  optionsJsonBytes: 64 * 1024,
  /** 合并 text 32KB。 */
  textBytes: 32 * 1024,
  /** structuredContent 序列化 128KB；超限整体省略，绝不输出半个 JSON。 */
  dataJsonBytes: 128 * 1024,
  /** upstream description ≤ 2000 字符。 */
  descriptionChars: 2000,
  /** upstream inputSchema 序列化 ≤ 8KB。 */
  argsSchemaJsonBytes: 8 * 1024,
  /** list 合并输出 16KB。 */
  listBytes: 16 * 1024,
} as const;

export interface ProxyServerEnvConfig {
  /** child 只继承这里的白名单变量；默认拒绝全继承（plan §5.1）。 */
  inherit: string[];
  /** 显式注入值；一律视为 secret，所有输出路径掩码 + 值扫描（plan §7.4）。 */
  set: Record<string, string>;
  /** M2：{ KEY: 文件路径 }，启动读取单行值，避免明文长期躺在配置。 */
  setFromFile?: Record<string, string>;
}

export interface ProxySurfaceConfig {
  /** 省略 = 全部暴露（unknown=confirm 兜底）；显式列表时未列出的 tool 是 hidden-tool 教学错误。 */
  expose?: string[];
  /** alias → canonical；不得与任何 canonical 名或其他 alias 冲突。 */
  aliases?: Record<string, string>;
}

/** 键一律用上游 canonical tool 名或 "*"（alias 先解析再过 policy，plan §5）。 */
export type ProxyRiskMap = Record<string, ProxyRiskDecision>;

export interface ProxyBrowserConfig {
  /** 导航白名单：命中 → allow，未知/open-world → confirm。M1 预留形状，M3 生效语义。 */
  allowedDomains: string[];
}

export interface ProxyServerConfig {
  name: string;
  /** M4.6 设置页启停开关：false = 配置保留但卸载出 proxy 运行时（agent 不可见）。 */
  enabled: boolean;
  /** Legacy compatibility flag. Proxy-first keeps upstream tools behind the proxy regardless of this value. */
  merge: boolean;
  transport: ProxyTransport;
  /** http 专有（M4）：StreamableHTTP 端点；stdio 时缺省。 */
  url?: string;
  /** http 专有：请求头（值支持 ${ENV_VAR} 机密引用展开）。 */
  headers?: Record<string, string>;
  command: string;
  args: string[];
  env: ProxyServerEnvConfig;
  surface: ProxySurfaceConfig;
  risk: ProxyRiskMap;
  /** 缺省 tool 级；显式指定的 tool 用 args 级（每套不同参数单独确认，仅 ONCE）。 */
  approvalUnits?: Record<string, ProxyApprovalUnitLevel>;
  /** 路径级强制脱敏（点路径，数组下标 * 通配），与键名无关。 */
  redactPaths: string[];
  sensitiveKeys: string[];
  /** Legacy config field; effective lifecycle is one daemon-owned shared connection. */
  scope: ProxyScope;
  /** 必须存在于构建产物（plan §5）；M1 的 profile 注册表为空 → 任何值都是 config_error。 */
  profile?: string;
  /** profile 专属命名空间：仅 profile: browser 时加载与校验。 */
  browser?: ProxyBrowserConfig;
  limits?: Partial<ProxyLimits>;
  prewarm: ProxyPrewarm;
}

/** list 输出的 server 状态全集——M1 即定稿，晚定会破坏 hint 文案稳定性（plan §6.1）。 */
export type ProxyServerStatus = 'offline' | 'starting' | 'online' | 'degraded' | 'crashed' | 'config_error';

/** 固定输出信封 status 枚举（plan §4）。 */
export type ProxyCallStatus = 'ok' | 'error' | 'denied' | 'unavailable' | 'timeout' | 'invalid_request';

export type ProxyAttachmentKind = 'image' | 'audio' | 'resource' | 'file';

/** attachment 元数据字段在 M1 冻结（plan §4/§9）；M3 只填值不改形状。 */
export interface ProxyAttachmentMeta {
  id: string;
  kind: ProxyAttachmentKind;
  mimeType?: string;
  name?: string;
  sizeBytes?: number;
  expiresAt?: string;
  sha256?: string;
}

/**
 * `proxy` 工具的稳定输出信封（plan §4）。此后冻结：新增字段必须全部可选
 * （§3.3 加法演进），删除/改名/改语义走契约评审。
 */
export interface ProxyResult {
  status: ProxyCallStatus;
  tool?: string;
  text?: string;
  dataJson?: string;
  truncated?: boolean;
  attachments?: ProxyAttachmentMeta[];
  hint?: string;
}

/** plan §4.1 timeout 的固定 hint 模板——教育 agent 先核实再重试。 */
export const PROXY_TIMEOUT_HINT = [
  'Upstream call timed out; its outcome is unknown.',
  'Before retrying, verify the outcome with an operation-specific read-only check, not list/explain.',
  'If it cannot be verified, stop and report the uncertainty. Do not blindly re-send the call.',
].join(' ');

/** 启动校验失败被隔离的 server：list 可见原因，不拖垮 daemon（plan §5.1）。 */
export interface QuarantinedProxyServer {
  name: string;
  reason: string;
}

/** 加载结果：可用 server + 停用 server + 隔离 server + 非致命告警 + 已注册机密。 */
export interface ProxyConfigLoad {
  servers: ProxyServerConfig[];
  /** enabled=false 的 server：配置保留在文件里，但不加载进运行时（agent 不可见）。 */
  disabled: ProxyServerConfig[];
  quarantined: QuarantinedProxyServer[];
  warnings: { name: string; reason: string }[];
  /** env.set / setFromFile 的值——供日志/异常文本做值扫描掩码（plan §7.4）。 */
  secretValues: string[];
}

/**
 * 教学型错误（plan §3.2）：所有错误必须带 hint；能给 example 的必须给。
 * 作为 dataJson 之外的 text 承载，禁止裸抛 Zod/SDK 异常。
 */
export interface TeachingError {
  status: 'invalid_request' | 'error' | 'unavailable' | 'denied';
  reason: string;
  hint: string;
  example?: Record<string, unknown>;
}
