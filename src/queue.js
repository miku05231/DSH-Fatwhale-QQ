// src/queue.js —— 按 key 串行的任务队列（不同 key 之间并行，零依赖）
//
// 用途：同一个人连发多条消息时按顺序处理，不同人之间互不阻塞。
// 失败不会卡住队尾：某个任务 reject 后，同 key 的后续任务照常执行。

/**
 * @typedef {{tail: Promise<unknown>, count: number}} Chain
 */

export class SerialQueue {
  constructor() {
    /** @type {Map<string, Chain>} key → 串行链（tail 为队尾 Promise，count 含正在跑的） */
    this.chains = new Map();
  }

  /**
   * 入队。同 key 串行、不同 key 并行。
   * @param {string|number} key 串行维度（一般用 QQ 号）
   * @param {() => any} fn 任务（可同步可异步）
   * @returns {Promise<any>} 解析为 fn 的返回值；fn 抛错/拒绝时同样拒绝
   */
  enqueue(key, fn) {
    if (typeof fn !== 'function') {
      return Promise.reject(new TypeError('SerialQueue.enqueue 的第二个参数必须是函数'));
    }
    const mapKey = String(key ?? '');
    let chain = this.chains.get(mapKey);
    if (!chain) {
      chain = { tail: Promise.resolve(), count: 0 };
      this.chains.set(mapKey, chain);
    }
    chain.count += 1;

    // 前一个任务结束（无论成功失败）后才启动下一个
    const task = chain.tail.then(() => fn());
    // 队尾用“吞掉异常”的版本，保证一次失败不会阻断同 key 的后续任务
    chain.tail = task.then(
      () => undefined,
      () => undefined,
    );

    const done = () => {
      chain.count -= 1;
      if (chain.count <= 0 && this.chains.get(mapKey) === chain) {
        this.chains.delete(mapKey);
      }
    };

    return task.then(
      (value) => {
        done();
        return value;
      },
      (error) => {
        done();
        throw error;
      },
    );
  }

  /**
   * 该 key 当前的任务数（排队 + 正在跑）。
   * @param {string|number} key
   * @returns {number}
   */
  size(key) {
    const chain = this.chains.get(String(key ?? ''));
    return chain ? chain.count : 0;
  }

  /** 全局在途任务数（所有 key 的排队 + 正在跑之和） */
  get total() {
    let sum = 0;
    for (const chain of this.chains.values()) sum += chain.count;
    return sum;
  }
}
