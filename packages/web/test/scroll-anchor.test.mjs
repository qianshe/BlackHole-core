import test from 'node:test';
import assert from 'node:assert/strict';
import { ANCHOR_ATTR, captureAnchor, anchorShift } from '../src/feed/scrollAnchor.ts';

// 用假对象模拟一列条目：每个条目高 h，首个条目的顶部为 y0，可视区域从 viewportTop 开始。
function list(keys, y0, h = 50) {
  const els = keys.map((key, i) => ({
    getAttribute: (name) => (name === ANCHOR_ATTR ? key : null),
    getBoundingClientRect: () => ({ top: y0 + i * h, bottom: y0 + (i + 1) * h }),
  }));
  return { querySelectorAll: (sel) => { assert.equal(sel, `[${ANCHOR_ATTR}]`); return els; } };
}

test('captureAnchor：取视口顶部边界之下的第一个条目，记下它相对边界的距离（被标题盖住一部分时为负）', () => {
  // 条目 a:[-30,20] b:[20,70] c:[70,120]，视口顶部在 0：a 仍然有 20px 可见
  assert.deepEqual(captureAnchor(list(['a', 'b', 'c'], -30), 0), { key: 'a', top: -30 });
  // 吸顶标题占 40px：a 已经完全在标题下面了（bottom=20 ≤ 40），取 b
  assert.deepEqual(captureAnchor(list(['a', 'b', 'c'], -30), 40), { key: 'b', top: -20 });
  assert.equal(captureAnchor(list([], 0), 0), null);
  assert.equal(captureAnchor(list(['a'], -500), 0), null, '全部在视口上方');
});

test('anchorShift：数据到了在上面插入内容后，返回需要再向下滚的像素数；重复计算不叠加', () => {
  const before = list(['m1', 'm2', 'm3'], 10);
  const anchor = captureAnchor(before, 0); // m1，top=10
  assert.deepEqual(anchor, { key: 'm1', top: 10 });
  // 没有任何变化（翻页请求还在路上）：偏移 0
  assert.equal(anchorShift(before, anchor, 0), 0);
  // 上面插入 4 个条目（各 50px），原来的条目往下跑了 200px
  const after = list(['o1', 'o2', 'o3', 'o4', 'm1', 'm2', 'm3'], 10);
  assert.equal(anchorShift(after, anchor, 0), 200);
  // 浏览器自己做了滚动锚定（已经往下滚了 120px）：只再补差的部分，不会叠加成 200 再加 120
  const anchored = list(['o1', 'o2', 'o3', 'o4', 'm1', 'm2', 'm3'], 10 - 120);
  assert.equal(anchorShift(anchored, anchor, 0), 80);
  // 补完之后再算一次是 0（幂等）
  assert.equal(anchorShift(list(['o1', 'o2', 'o3', 'o4', 'm1', 'm2', 'm3'], 10 - 200), anchor, 0), 0);
});

test('anchorShift：锚点条目不在了返回 null（调用方不补偿）；键里有特殊字符也能匹配', () => {
  const anchor = { key: 'gone', top: 0 };
  assert.equal(anchorShift(list(['a', 'b'], 0), anchor, 0), null);
  const odd = captureAnchor(list(['1700.c.a"b]c'], 0), 0);
  assert.equal(anchorShift(list(['x', '1700.c.a"b]c'], 0), odd, 0), 50);
});
