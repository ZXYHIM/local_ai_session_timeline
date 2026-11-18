/**
 * 主线程编排：分块读取、inline Blob Worker + try/catch 降级、消息收发、导出下载。
 *
 * 两条执行路径共用同一 parser.ts 内核与 finalizeEvents 入口，输出逐字段一致：
 * - worker 路径：Chrome / Firefox 的 file:// 下 Blob Worker（CSP worker-src blob:）；
 * - compat 路径：Safari 等 Worker 构造抛 SecurityError 时的主线程协作式降级，
 *   每 1500 行让出一次主线程（scheduler.yield → requestIdleCallback → setTimeout(0)）。
 */

import ParserWorker from './parser.worker?worker&inline';
import {
  buildIndex,
  buildReviewPackage,
  cloneStats,
  computeUsageTotal,
  createEmptyStats,
  finalizeEvents,
  normalize,
  parseLine,
  renderReport,
  sanitize,
  search,
  toReviewItem,
} from './parser';
import type {
  FieldMap,
  MaskOptions,
  NormalizedEvent,
  ParseMode,
  ParseStats,
  ReviewItem,
  ReviewPackage,
  SearchIndex,
  WorkerRequest,
  WorkerResponse,
} from './types';

/** 分块大小：2MB */
export const CHUNK_SIZE = 2 * 1024 * 1024;

/** 兼容模式每批处理行数（1000–2000 区间取中） */
const COMPAT_BATCH_LINES = 1500;

export interface RunnerCallbacks {
  onProgress(stats: ParseStats): void;
  onDone(stats: ParseStats, eventCount: number): void;
  onWindowRows(rows: NormalizedEvent[]): void;
  onSearchResult(ids: number[]): void;
  onModeChange(mode: ParseMode): void;
  onError(message: string): void;
}

export interface ReviewBundle {
  pkg: ReviewPackage;
  items: ReviewItem[];
}

export interface ParserRunner {
  readonly mode: ParseMode;
  requestWindow(start: number, count: number): void;
  requestSearch(query: string, limit: number): void;
  requestExport(mask: MaskOptions): Promise<string>;
  requestReview(seqs: number[]): Promise<ReviewBundle>;
  dispose(): void;
}

/** 兼容模式 runner 额外暴露的解析入口（仅由 createParserRunner 内部调用） */
interface LocalRunner extends ParserRunner {
  parseFile(file: File): Promise<void>;
}

// ---------------------------------------------------------------------------
// 文件分块读取
// ---------------------------------------------------------------------------

export interface ChunkHandlers {
  onChunk(lines: string[], startLineNo: number): void | Promise<void>;
  onBytesRead(bytes: number): void;
}

/** 分块读取：Blob.slice 2MB + TextDecoder{stream:true}；BOM 只首块剥一次；尾部半行单独发一次 */
export async function readChunks(file: File, handlers: ChunkHandlers): Promise<void> {
  const decoder = new TextDecoder('utf-8');
  let carry = '';
  let lineNo = 0;
  let offset = 0;
  let firstChunk = true;
  while (offset < file.size) {
    const end = Math.min(offset + CHUNK_SIZE, file.size);
    const buffer = await sliceToArrayBuffer(file, offset, end);
    offset = end;
    let text = decoder.decode(buffer, { stream: offset < file.size });
    if (firstChunk) {
      // BOM 只首块剥一次（TextDecoder 默认亦会吞 BOM，此处为显式兜底）
      if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
      firstChunk = false;
    }
    const parts = (carry + text).split('\n');
    carry = parts.pop() ?? '';
    if (parts.length > 0) {
      await handlers.onChunk(parts, lineNo);
      lineNo += parts.length;
    }
    handlers.onBytesRead(end);
  }
  const tail = carry + decoder.decode();
  if (tail !== '') {
    // 尾部半行：parseLine 会尝试一次 JSON.parse，失败计入 skipped，绝不中断
    await handlers.onChunk([tail], lineNo);
  }
}

async function sliceToArrayBuffer(blob: Blob, start: number, end: number): Promise<ArrayBuffer> {
  const slice = blob.slice(start, end);
  if (typeof slice.arrayBuffer === 'function') {
    return slice.arrayBuffer();
  }
  // 老 Safari 特性检测回退：FileReader.readAsArrayBuffer
  return await new Promise<ArrayBuffer>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as ArrayBuffer);
    reader.onerror = () => reject(reader.error ?? new Error('FileReader 读取失败'));
    reader.readAsArrayBuffer(slice);
  });
}

// ---------------------------------------------------------------------------
// 兼容模式：主线程协作式让出
// ---------------------------------------------------------------------------

interface SchedulerLike {
  yield?: () => Promise<void>;
}
interface IdleGlobal {
  requestIdleCallback?: (callback: () => void) => number;
}

function yieldToUI(): Promise<void> {
  const scheduler = (globalThis as { scheduler?: SchedulerLike }).scheduler;
  if (scheduler !== undefined && typeof scheduler.yield === 'function') {
    return scheduler.yield();
  }
  const idle = globalThis as IdleGlobal;
  if (typeof idle.requestIdleCallback === 'function') {
    return new Promise<void>((resolve) => {
      idle.requestIdleCallback?.(() => resolve());
    });
  }
  return new Promise<void>((resolve) => {
    setTimeout(resolve, 0);
  });
}

// ---------------------------------------------------------------------------
// 兼容模式 Runner（与 Worker 路径共用同一内核）
// ---------------------------------------------------------------------------

function createLocalRunner(fieldMap: FieldMap, callbacks: RunnerCallbacks): LocalRunner {
  let events: NormalizedEvent[] = [];
  let index: SearchIndex = { searchText: [] };
  let stats: ParseStats = createEmptyStats();
  let finalized = false;
  let startedAt = 0;

  const absorbLine = (text: string, lineNo: number): void => {
    const raw = parseLine(text, lineNo);
    stats.totalLines += 1;
    if (raw.status !== 'ok') {
      stats.skippedLines += 1;
      stats.skippedByReason[raw.status] = (stats.skippedByReason[raw.status] ?? 0) + 1;
      return;
    }
    stats.okLines += 1;
    const ev = normalize(raw, fieldMap);
    stats.byKind[ev.kind] += 1;
    if (ev.kind === 'unknown') stats.unknownCount += 1;
    events.push(ev);
  };

  const parseFile = async (file: File): Promise<void> => {
    events = [];
    index = { searchText: [] };
    stats = createEmptyStats();
    finalized = false;
    startedAt = Date.now();
    try {
      await readChunks(file, {
        onChunk: async (lines, startLineNo) => {
          for (let i = 0; i < lines.length; i += COMPAT_BATCH_LINES) {
            const batch = lines.slice(i, i + COMPAT_BATCH_LINES);
            for (let j = 0; j < batch.length; j += 1) {
              absorbLine(batch[j], startLineNo + i + j);
            }
            // 协作式让出：解析期间输入框 / 滚动可正常响应
            await yieldToUI();
          }
          callbacks.onProgress(cloneStats(stats));
        },
        onBytesRead: (bytes) => {
          stats.bytesRead = bytes;
        },
      });
      const result = finalizeEvents(events);
      events = result.events;
      stats.mergedDuplicates = result.mergedDuplicates;
      stats.usageTotal = computeUsageTotal(events);
      stats.durationMs = Date.now() - startedAt;
      index = buildIndex(events);
      finalized = true;
      callbacks.onDone(cloneStats(stats), events.length);
    } catch (err) {
      callbacks.onError(`文件读取失败：${err instanceof Error ? err.message : String(err)}`);
    }
  };

  return {
    mode: 'compat',
    parseFile,
    requestWindow(start, count) {
      const s = Math.max(0, Math.floor(start));
      const e = Math.min(events.length, s + Math.max(0, Math.floor(count)));
      const rows = finalized ? events.slice(s, e) : [];
      queueMicrotask(() => callbacks.onWindowRows(rows));
    },
    requestSearch(query, limit) {
      const ids = finalized ? search(index, query, limit) : [];
      queueMicrotask(() => callbacks.onSearchResult(ids));
    },
    requestExport(mask) {
      return new Promise<string>((resolve, reject) => {
        queueMicrotask(() => {
          if (!finalized) {
            reject(new Error('尚未完成解析，无法导出'));
            return;
          }
          try {
            resolve(renderReport(events.map((ev) => sanitize(ev, mask)), stats, mask));
          } catch (err) {
            reject(err instanceof Error ? err : new Error(String(err)));
          }
        });
      });
    },
    requestReview(seqs) {
      return new Promise<ReviewBundle>((resolve, reject) => {
        queueMicrotask(() => {
          if (!finalized) {
            reject(new Error('尚未完成解析，无法生成复盘包'));
            return;
          }
          try {
            const wanted = new Set(seqs);
            const items = events
              .filter((ev) => wanted.has(ev.seq))
              .sort((a, b) => a.seq - b.seq)
              .map(toReviewItem);
            resolve({ pkg: buildReviewPackage(events, stats, { seqs: wanted }), items });
          } catch (err) {
            reject(err instanceof Error ? err : new Error(String(err)));
          }
        });
      });
    },
    dispose() {
      events = [];
      index = { searchText: [] };
    },
  };
}

// ---------------------------------------------------------------------------
// Worker Runner + 降级
// ---------------------------------------------------------------------------

interface PendingRequest {
  resolve(value: unknown): void;
  reject(error: Error): void;
}

function createWorkerRunner(
  file: File,
  fieldMap: FieldMap,
  callbacks: RunnerCallbacks,
): { runner: ParserRunner; start: () => void } {
  let worker: Worker | null = null;
  let requestSeq = 0;
  let lastWindowRequestId = '';
  let doneOrFailed = false;
  let fallback: LocalRunner | null = null;
  const pending = new Map<string, PendingRequest>();

  const nextRequestId = (): string => {
    requestSeq += 1;
    return String(requestSeq);
  };

  const startLocalFallback = (reason: string): void => {
    if (doneOrFailed || fallback !== null) return;
    doneOrFailed = true;
    if (worker !== null) {
      try {
        worker.terminate();
      } catch {
        // 忽略 terminate 异常
      }
      worker = null;
    }
    for (const [, p] of pending) p.reject(new Error(`Worker 路径不可用：${reason}`));
    pending.clear();
    callbacks.onError(
      `Worker 路径不可用（${reason}）：已切换到兼容模式（同一解析内核，主线程分块执行，速度较慢）。`,
    );
    callbacks.onModeChange('compat');
    fallback = createLocalRunner(fieldMap, callbacks);
    void fallback.parseFile(file);
  };

  const send = (req: WorkerRequest): void => {
    if (worker === null) throw new Error('worker 已降级');
    worker.postMessage(req);
  };

  const delegateRunner = (): ParserRunner => ({
    get mode(): ParseMode {
      return fallback !== null ? 'compat' : 'worker';
    },
    requestWindow(start, count) {
      if (fallback !== null) {
        fallback.requestWindow(start, count);
        return;
      }
      const requestId = nextRequestId();
      lastWindowRequestId = requestId;
      try {
        send({ type: 'window', requestId, start, count });
      } catch {
        // 降级后由 fallback 接管；本次请求丢弃
      }
    },
    requestSearch(query, limit) {
      if (fallback !== null) {
        fallback.requestSearch(query, limit);
        return;
      }
      try {
        send({ type: 'search', requestId: nextRequestId(), query, limit });
      } catch {
        // 忽略：降级路径接管
      }
    },
    requestExport(mask) {
      if (fallback !== null) return fallback.requestExport(mask);
      return new Promise<string>((resolve, reject) => {
        const requestId = nextRequestId();
        pending.set(requestId, { resolve: resolve as (v: unknown) => void, reject });
        try {
          send({ type: 'export', requestId, mask });
        } catch (err) {
          pending.delete(requestId);
          reject(err instanceof Error ? err : new Error(String(err)));
        }
      });
    },
    requestReview(seqs) {
      if (fallback !== null) return fallback.requestReview(seqs);
      return new Promise<ReviewBundle>((resolve, reject) => {
        const requestId = nextRequestId();
        pending.set(requestId, { resolve: resolve as (v: unknown) => void, reject });
        try {
          send({ type: 'review', requestId, seqs });
        } catch (err) {
          pending.delete(requestId);
          reject(err instanceof Error ? err : new Error(String(err)));
        }
      });
    },
    dispose() {
      if (fallback !== null) {
        fallback.dispose();
        return;
      }
      for (const [, p] of pending) p.reject(new Error('runner 已销毁'));
      pending.clear();
      if (worker !== null) {
        try {
          worker.terminate();
        } catch {
          // 忽略
        }
        worker = null;
      }
    },
  });

  try {
    worker = new ParserWorker();
  } catch (err) {
    // Safari file:// 下 Blob Worker 可能抛 SecurityError：构造即降级
    startLocalFallback(err instanceof Error ? err.message : 'Worker 构造失败');
    return { runner: delegateRunner(), start: () => undefined };
  }

  worker.onerror = (ev: ErrorEvent): void => {
    startLocalFallback(ev.message !== '' ? ev.message : 'worker 运行错误');
  };

  worker.onmessage = (ev: MessageEvent<WorkerResponse>): void => {
    const msg = ev.data;
    switch (msg.type) {
      case 'progress': {
        callbacks.onProgress(msg.stats);
        return;
      }
      case 'windowRows': {
        if (msg.requestId === lastWindowRequestId) callbacks.onWindowRows(msg.rows);
        return;
      }
      case 'searchResult': {
        callbacks.onSearchResult(msg.ids);
        return;
      }
      case 'done': {
        doneOrFailed = true;
        callbacks.onProgress(msg.stats);
        callbacks.onDone(msg.stats, msg.eventCount);
        return;
      }
      case 'report': {
        const p = pending.get(msg.requestId);
        pending.delete(msg.requestId);
        p?.resolve(msg.html);
        return;
      }
      case 'reviewPackage': {
        const p = pending.get(msg.requestId);
        pending.delete(msg.requestId);
        p?.resolve({ pkg: msg.pkg, items: msg.items });
        return;
      }
      case 'error': {
        const p = pending.get(msg.requestId);
        pending.delete(msg.requestId);
        if (p !== undefined) p.reject(new Error(msg.message));
        else callbacks.onError(msg.message);
        return;
      }
      default: {
        return;
      }
    }
  };

  const start = (): void => {
    if (fallback !== null) return;
    try {
      send({ type: 'init', requestId: nextRequestId(), fieldMap });
    } catch (err) {
      // try/catch 包住首消息
      startLocalFallback(err instanceof Error ? err.message : '首消息发送失败');
      return;
    }
    void (async () => {
      try {
        await readChunks(file, {
          onChunk: (lines, startLineNo) => {
            send({ type: 'chunk', requestId: nextRequestId(), lines, startLineNo });
          },
          onBytesRead: (bytes) => {
            send({ type: 'bytes', requestId: nextRequestId(), bytes });
          },
        });
        send({ type: 'finalize', requestId: nextRequestId() });
      } catch (err) {
        startLocalFallback(err instanceof Error ? err.message : '分块读取失败');
      }
    })();
  };

  return { runner: delegateRunner(), start };
}

// ---------------------------------------------------------------------------
// 对外唯一入口
// ---------------------------------------------------------------------------

/**
 * 创建解析 runner 并立即开始解析指定文件。
 * Worker 构造 / 首消息 / 运行期异常都会自动降级到主线程兼容模式（UI 会收到 onModeChange）。
 */
export function createParserRunner(
  file: File,
  fieldMap: FieldMap,
  callbacks: RunnerCallbacks,
): ParserRunner {
  const { runner, start } = createWorkerRunner(file, fieldMap, callbacks);
  callbacks.onModeChange(runner.mode);
  start();
  return runner;
}

// ---------------------------------------------------------------------------
// 导出下载（Blob → createObjectURL → 临时 a[download] → click → revoke + 移除节点）
// ---------------------------------------------------------------------------

export function download(html: string, filename: string): void {
  const blob = new Blob([html], { type: 'text/html;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.rel = 'noopener';
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
  URL.revokeObjectURL(url);
}
