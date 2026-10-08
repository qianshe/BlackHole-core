/**
 * 往上翻页后保持视图不动（手机的整页滚动和 Web 控制台的 feed 容器共用）：
 * 翻页前记下视口里第一个条目和它离视口顶部的距离，数据到了再把同一个条目挨回原位。
 * 比「记下高度、事后补差值」稳：不依赖高度什么时候变、重复触发不会叠加（对同一个锚点重复执行结果相同），
 * 浏览器自己做了滚动锚定、条目晚一点才折叠都不会算错。
 *
 * 只用最小的 DOM 形状（可用假对象测试），只用可擦除的 TS 语法。
 */

/** 每个时间线条目的根元素上都带这个属性（值是调用/回复的 id）。 */
export const ANCHOR_ATTR = 'data-feed-key';

export interface AnchorEl {
  getAttribute(name: string): string | null;
  getBoundingClientRect(): { top: number; bottom: number };
}
export interface AnchorRoot {
  querySelectorAll(selector: string): ArrayLike<AnchorEl>;
}
export interface ScrollAnchor {
  key: string;
  /** 条目顶部相对「视口顶部边界」的距离（可为负：条目被盖在吸顶标题或翻出去一部分）。 */
  top: number;
}

/** 记下「视口顶部边界」之下的第一个条目。`viewportTop`：可见区域的顶部（手机是吸顶标题的底边，Web 是滚动容器的顶边）。 */
export function captureAnchor(root: AnchorRoot, viewportTop: number): ScrollAnchor | null {
  const els = root.querySelectorAll(`[${ANCHOR_ATTR}]`);
  for (let i = 0; i < els.length; i++) {
    const el = els[i]!;
    const rect = el.getBoundingClientRect();
    const key = el.getAttribute(ANCHOR_ATTR);
    if (key !== null && rect.bottom > viewportTop) return { key, top: rect.top - viewportTop };
  }
  return null;
}

/**
 * 锚点条目现在相对当时位置偏移了多少像素（正 = 内容往下跑了，需要再向下滚这么多）；找不到这个条目返回 null。
 * 不用 CSS 选择器按键查找：键里可能有需要转义的字符。
 */
export function anchorShift(root: AnchorRoot, anchor: ScrollAnchor, viewportTop: number): number | null {
  const els = root.querySelectorAll(`[${ANCHOR_ATTR}]`);
  for (let i = 0; i < els.length; i++) {
    const el = els[i]!;
    if (el.getAttribute(ANCHOR_ATTR) === anchor.key) return el.getBoundingClientRect().top - viewportTop - anchor.top;
  }
  return null;
}
