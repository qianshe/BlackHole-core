import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Structural preview of the user-level Skill library for the settings panel
 * (same wording as the VS Code panel). Not a validation of the skills.
 */
export function skillDirectoryStatus(custom: string, home = os.homedir()): { directory: string; cls: '' | 'ok' | 'bad'; hint: string } {
  const directory = custom
    ? path.resolve(custom === '~' ? home : /^~[\\/]/.test(custom) ? path.join(home, custom.slice(2).replace(/[\\/]/g, path.sep)) : custom)
    : path.join(home, '.agents', 'skills');
  const scope = custom ? '自定义目录' : '默认用户目录';
  try {
    let existing = directory;
    for (;;) {
      try { fs.lstatSync(existing); break; }
      catch (error) {
        const parent = path.dirname(existing);
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || parent === existing) throw error;
        existing = parent;
      }
    }
    if (!fs.statSync(existing).isDirectory()) return { directory, cls: 'bad', hint: `${scope}路径或父路径不是目录；请修正配置。` };
    if (existing !== directory) return { directory, cls: custom ? 'bad' : '',
      hint: custom ? '自定义目录不存在，不会回退到默认用户目录；会话仍会检查项目 Skill。'
        : `默认目录尚未创建：${directory}；会话仍会检查项目 Skill。` };
    let count = 0;
    for (const name of fs.readdirSync(directory)) {
      try {
        const dir = path.join(directory, name);
        if (fs.statSync(dir).isDirectory() && fs.statSync(path.join(dir, 'SKILL.md')).isFile()) count++;
      } catch { /* structural preview only */ }
    }
    return { directory, cls: count ? 'ok' : '', hint: `${scope}有 ${count} 个 Skill。` };
  } catch { return { directory, cls: 'bad', hint: `${scope}无法读取或链接失效；完整 Skill 发现可能失败，请修正配置。` }; }
}
