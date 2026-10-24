import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
const script = fs.readFileSync(new URL('../installers/windows/desktop.iss', import.meta.url), 'utf8');

test('desktop shortcut is a default-selected per-user task with stable target after update', () => {
  assert.match(script, /UsePreviousTasks=yes/);
  assert.match(script, /PrivilegesRequired=lowest/);
  const task = script.split('\n').find(line => line.startsWith('Name: "desktopicon";'));
  assert.ok(task, 'missing desktop shortcut task');
  assert.doesNotMatch(task, /unchecked/);
  const icon = script.split('\n').find(line => line.includes('{autodesktop}'));
  assert.ok(icon, 'missing current-user desktop shortcut');
  assert.match(icon, /Filename: "\{app\}\\blackhole\.exe"/);
  assert.match(icon, /Tasks: desktopicon/);
  assert.match(icon, /WorkingDir: "\{app\}"/);
});

test('installer protects the old v200 user data and never includes credentials in payload', () => {
  assert.ok(script.includes("AddBackslash(GetEnv('USERPROFILE')) + '.blackhole'"));
  const files = script.split('\n').filter(line => line.startsWith('Source:'));
  assert.equal(files.length, 9);
  assert.equal(files.filter(line => line.includes('Flags: dontcopy')).length, 1);
  for (const line of files) assert.doesNotMatch(line, /blackhole\.db|secrets|cloud-auth-v1|mcp-proxies|\.blackhole/);
  assert.doesNotMatch(script, /\[UninstallDelete\]/i);
});
