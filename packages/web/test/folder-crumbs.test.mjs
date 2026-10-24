import test from 'node:test';
import assert from 'node:assert/strict';
import { folderCrumbs } from '../src/folderCrumbs.ts';

test('Core folder breadcrumbs preserve Windows drive navigation', () => {
  assert.deepEqual(folderCrumbs('D:\\myProject\\tools'), [
    { label: 'D:', path: 'D:\\' },
    { label: 'myProject', path: 'D:\\myProject' },
    { label: 'tools', path: 'D:\\myProject\\tools' },
  ]);
  assert.deepEqual(folderCrumbs('C:\\'), [{ label: 'C:', path: 'C:\\' }]);
});

test('Core folder breadcrumbs preserve UNC share and POSIX paths', () => {
  assert.deepEqual(folderCrumbs('\\\\host\\share\\repo'), [
    { label: 'host / share', path: '\\\\host\\share\\' },
    { label: 'repo', path: '\\\\host\\share\\repo' },
  ]);
  assert.deepEqual(folderCrumbs('/home/agent/repo'), [
    { label: '/', path: '/' },
    { label: 'home', path: '/home' },
    { label: 'agent', path: '/home/agent' },
    { label: 'repo', path: '/home/agent/repo' },
  ]);
  assert.deepEqual(folderCrumbs(''), []);
});
