/**
 * 引用计数的登记表（没有 React 依赖，可以直接单测）：同一个键的多个使用者（时间线、输入框……）共用一个条目，
 * 第一个使用者出现时启动，最后一个离开后延后一拍才停（兼容 React 严格模式重挂、同会话组件换挂，不必重新来一遍 full）。
 *
 * 只用可擦除的 TS 语法（不用参数属性），因为测试直接用 Node 跑 .ts。
 */

export interface RegistrySlot<T> {
  item: T;
  /** 当前有多少个使用者。 */
  refs: number;
  /** 已安排但还没执行的「延后停止」的取消函数。 */
  cancel: (() => void) | null;
  /** 条目是否已启动（重挂时不重复启动）。 */
  started: boolean;
}

export interface RegistryHooks<T> {
  start(item: T): void;
  stop(item: T): void;
  /** 延后一拍执行，返回取消函数；缺省 setTimeout(0)。测试里可以注入。 */
  defer?: (fn: () => void) => () => void;
}

const defaultDefer = (fn: () => void): (() => void) => {
  const timer = setTimeout(fn, 0);
  return () => clearTimeout(timer);
};

export class FeedRegistry<T> {
  private readonly slots = new Map<string, RegistrySlot<T>>();
  private readonly hooks: RegistryHooks<T>;

  constructor(hooks: RegistryHooks<T>) {
    this.hooks = hooks;
  }

  /** 取（没有就建）键对应的条目；不计引用，渲染期可以调用（严格模式会渲染两次，第二次拿到的是同一个）。 */
  slot(key: string, create: () => T): RegistrySlot<T> {
    let slot = this.slots.get(key);
    if (!slot) {
      slot = { item: create(), refs: 0, cancel: null, started: false };
      this.slots.set(key, slot);
    }
    return slot;
  }

  /** 登记一个使用者；返回释放函数（只生效一次）。第一个使用者启动条目。 */
  acquire(key: string, slot: RegistrySlot<T>): () => void {
    if (slot.cancel) { slot.cancel(); slot.cancel = null; }
    // 渲染时拿到了条目，但组件的 effect 比别人的「延后停止」还晚：条目已经被停掉并从表里删掉，这里放回去并重新启动
    if (this.slots.get(key) === undefined) this.slots.set(key, slot);
    slot.refs += 1;
    // 释放后在「延后一拍」之前又登记（严格模式重挂）：条目还在跑，不重新启动
    if (!slot.started) { slot.started = true; this.hooks.start(slot.item); }
    let released = false;
    return () => {
      if (released) return;
      released = true;
      if (--slot.refs > 0) return;
      const defer = this.hooks.defer ?? defaultDefer;
      slot.cancel = defer(() => {
        slot.cancel = null;
        if (slot.refs > 0) return;
        slot.started = false;
        this.hooks.stop(slot.item); // 即使表里已经换成了另一个条目，这一个也要停，不能泄漏
        if (this.slots.get(key) === slot) this.slots.delete(key);
      });
    };
  }

  /** 现在登记着多少个条目（测试用）。 */
  size(): number {
    return this.slots.size;
  }
}
