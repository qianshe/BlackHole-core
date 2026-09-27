import { parseDocument } from 'yaml';

/**
 * M4 设置页引导式编辑的服务端合并（plan §5.2 第二步）：
 * UI 只送白名单字段的值。连接定义里的 transport/command/args/url 允许编辑；
 * 机密（headers/env）以及身份/生命周期字段仍不从设置页写回。YAML 文档树原位替换，
 * 注释与文档结构经 parseDocument/stringify 保留。
 */

/** 允许 UI 写回的字段（§5.2 白名单；其余一律拒绝）。enabled = M4.6 启停开关。 */
export const EDITABLE_FIELDS = [
  'transport',
  'url',
  'command',
  'args',
  'surface',
  'risk',
  'approvalUnits',
  'redactPaths',
  'sensitiveKeys',
  'limits',
  'prewarm',
  'browser',
  'enabled',
] as const;

export type EditableField = (typeof EDITABLE_FIELDS)[number];

/** 白名单外字段（file-only 红线，plan §5.2）。 */
const FORBIDDEN_FIELDS = ['name', 'headers', 'env', 'scope', 'profile'];

/**
 * 把 UI 提交的 whitelist 字段合并进 YAML 文档中 `name` 对应的 server 条目。
 * 返回新的 YAML 文本。找不到 server / 白名单外字段 → 抛错（调用方 400）。
 * 值为 `null` = 删除该字段（UI 清空列表的语义：清空 ≠ 写空数组，
 * 例如 surface.expose 清空应当是"回到省略 = 全部暴露"）。
 */
export function mergeEditableFields(sourceYaml: string, serverName: string, fields: Record<string, unknown>): string {
  const forbidden = Object.keys(fields).filter((k) => (FORBIDDEN_FIELDS as string[]).includes(k));
  if (forbidden.length > 0) {
    throw new Error(`file-only fields cannot be edited via UI: ${forbidden.join(', ')}`);
  }
  const unknown = Object.keys(fields).filter((k) => !(EDITABLE_FIELDS as readonly string[]).includes(k));
  if (unknown.length > 0) {
    throw new Error(`unknown editable fields: ${unknown.join(', ')}`);
  }
  const doc = parseDocument(sourceYaml);
  const proxies = doc.get('proxies');
  if (proxies === undefined || typeof proxies !== 'object' || !('items' in (proxies as object))) {
    throw new Error('no proxies list in config');
  }
  const items = (proxies as { items: unknown[] }).items;
  let targetFound = false;
  for (const item of items) {
    const node = item as { get?: (k: string) => unknown; set: (k: string, v: unknown) => void; delete?: (k: string) => boolean };
    const nameNode = node.get?.('name');
    if (nameNode !== serverName) continue;
    targetFound = true;
    for (const [field, value] of Object.entries(fields)) {
      if (value === null) {
        // 原位删除（注释随节点一起消失，语义上等于回到"未配置"）
        node.delete?.(field);
        continue;
      }
      // 原位替换（set 保留注释）；新增字段追加在条目末尾
      node.set(field, value);
    }
  }
  if (!targetFound) throw new Error(`no server named "${serverName}" in config`);
  return String(doc);
}

/**
 * M4.6 设置页「新增 MCP」/「JSON 导入」：把新 server 条目追加进 YAML 文档的
 * proxies 列表（parseDocument 保留既有注释），返回合并后的 YAML 文本。
 * 条目内容由调用方先经 validateServerEntry 校验。
 */
export function appendServerToYaml(sourceYaml: string, entry: Record<string, unknown>): string {
  const doc = parseDocument(sourceYaml);
  const proxies = doc.get('proxies');
  // v2.5 修复：空文档 = 用户第一次添加（设置页冷启动场景）——seed 出 proxies 列表；
  // 非空但没有 proxies 键的文档仍报错（不猜用户意图）
  if (sourceYaml.trim() === '' && proxies === undefined) {
    const seeded = parseDocument('proxies: []\n');
    seeded.addIn(['proxies'], entry);
    return String(seeded);
  }
  if (proxies === undefined || typeof proxies !== 'object' || !('items' in (proxies as object))) {
    throw new Error('no proxies list in config');
  }
  // 重名防御：追加前再查一遍文档里的名字（调用方的 seenNames 可能来自旧快照）
  for (const item of (proxies as { items: { get?: (k: string) => unknown }[] }).items) {
    if (item.get?.('name') === entry.name) {
      throw new Error(`duplicate server name "${String(entry.name)}"`);
    }
  }
  doc.addIn(['proxies'], entry);
  return String(doc);
}

/** 探活失败回滚：从 YAML 文档中摘除指定 name 的 server 条目（注释保留）。 */
export function removeServerFromYaml(sourceYaml: string, serverName: string): string {
  const doc = parseDocument(sourceYaml);
  const proxies = doc.get('proxies');
  if (proxies === undefined || typeof proxies !== 'object' || !('items' in (proxies as object))) {
    return String(doc);
  }
  const seq = proxies as { items: { get?: (k: string) => unknown }[] };
  for (let i = seq.items.length - 1; i >= 0; i--) {
    const item = seq.items[i];
    if (item !== undefined && item.get?.('name') === serverName) {
      seq.items.splice(i, 1);
      break;
    }
  }
  return String(doc);
}
