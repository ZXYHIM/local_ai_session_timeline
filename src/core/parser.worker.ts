/**
 * Worker 入口：import 同一 parser.ts 内核，持有全量事件 / 索引 / 统计。
 * 消息协议统一 {type, requestId, ...payload}；错误只走 {type:'error'}，绝不向全局抛异常。
 */

import {
  buildIndex,
  buildReviewPackage,
  createEmptyStats,
  cloneStats,
  computeUsageTotal,
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
  NormalizedEvent,
  ParseStats,
  SearchIndex,
  WorkerRequest,
  WorkerResponse,
} from './types';

/** 进度上报节奏：每处理 2000 行 postMessage 一次 */
const PROGRESS_EVERY_LINES = 2000;

let fieldMap: FieldMap | null = null;
let events: NormalizedEvent[] = [];
let index: SearchIndex = { searchText: [] };
let stats: ParseStats = createEmptyStats();
let startedAt = 0;
let finalized = false;

// file:// 下 opaque origin：不依赖 DedicatedWorkerGlobalScope 的 lib 类型，
// 通过最小结构类型访问 worker 上下文（DOM 与 WebWorker lib 并存时避免全局冲突）。
const ctx = self as unknown as {
  postMessage(message: WorkerResponse): void;
  addEventListener(type: 'message', listener: (ev: MessageEvent<WorkerRequest>) => void): void;
};

function postProgress(requestId: string): void {
  ctx.postMessage({ type: 'progress', requestId, stats: cloneStats(stats) });
}

function resetState(nextFieldMap: FieldMap): void {
  fieldMap = nextFieldMap;
  events = [];
  index = { searchText: [] };
  stats = createEmptyStats();
  startedAt = Date.now();
  finalized = false;
}

function absorbLine(text: string, lineNo: number): void {
  const raw = parseLine(text, lineNo);
  stats.totalLines += 1;
  if (raw.status !== 'ok') {
    stats.skippedLines += 1;
    stats.skippedByReason[raw.status] = (stats.skippedByReason[raw.status] ?? 0) + 1;
    return;
  }
  stats.okLines += 1;
  const ev = normalize(raw, fieldMap as FieldMap);
  stats.byKind[ev.kind] += 1;
  if (ev.kind === 'unknown') stats.unknownCount += 1;
  events.push(ev);
}

function finalizeStats(): void {
  const result = finalizeEvents(events);
  events = result.events;
  stats.mergedDuplicates = result.mergedDuplicates;
  // 数据口径全局唯一：usageTotal 只在 dedupe 之后计算
  stats.usageTotal = computeUsageTotal(events);
  stats.durationMs = Date.now() - startedAt;
  index = buildIndex(events);
  finalized = true;
}

function handleRequest(req: WorkerRequest): void {
  try {
    switch (req.type) {
      case 'init': {
        resetState(req.fieldMap);
        return;
      }
      case 'chunk': {
        if (fieldMap === null) {
          ctx.postMessage({
            type: 'error',
            requestId: req.requestId,
            message: 'worker 未初始化（缺少 init 消息）',
          });
          return;
        }
        let sinceProgress = 0;
        for (let i = 0; i < req.lines.length; i += 1) {
          absorbLine(req.lines[i], req.startLineNo + i);
          sinceProgress += 1;
          if (sinceProgress >= PROGRESS_EVERY_LINES) {
            postProgress(req.requestId);
            sinceProgress = 0;
          }
        }
        if (sinceProgress > 0) postProgress(req.requestId);
        return;
      }
      case 'bytes': {
        // 主线程分块读取进度（累计已读取字节数）
        stats.bytesRead = req.bytes;
        return;
      }
      case 'finalize': {
        finalizeStats();
        ctx.postMessage({
          type: 'done',
          requestId: req.requestId,
          stats: cloneStats(stats),
          eventCount: events.length,
        });
        return;
      }
      case 'window': {
        if (!finalized) {
          ctx.postMessage({ type: 'windowRows', requestId: req.requestId, rows: [] });
          return;
        }
        const start = Math.max(0, Math.floor(req.start));
        const end = Math.min(events.length, start + Math.max(0, Math.floor(req.count)));
        ctx.postMessage({ type: 'windowRows', requestId: req.requestId, rows: events.slice(start, end) });
        return;
      }
      case 'search': {
        const ids = finalized ? search(index, req.query, req.limit) : [];
        ctx.postMessage({ type: 'searchResult', requestId: req.requestId, ids });
        return;
      }
      case 'export': {
        if (!finalized) {
          ctx.postMessage({
            type: 'error',
            requestId: req.requestId,
            message: '尚未完成解析，无法导出',
          });
          return;
        }
        const sanitized = events.map((ev) => sanitize(ev, req.mask));
        const html = renderReport(sanitized, stats, req.mask);
        ctx.postMessage({ type: 'report', requestId: req.requestId, html });
        return;
      }
      case 'review': {
        if (!finalized) {
          ctx.postMessage({
            type: 'error',
            requestId: req.requestId,
            message: '尚未完成解析，无法生成复盘包',
          });
          return;
        }
        const wanted = new Set(req.seqs);
        const selected = events
          .filter((ev) => wanted.has(ev.seq))
          .sort((a, b) => a.seq - b.seq)
          .map(toReviewItem);
        const pkg = buildReviewPackage(events, stats, { seqs: wanted });
        ctx.postMessage({
          type: 'reviewPackage',
          requestId: req.requestId,
          pkg,
          items: selected,
        });
        return;
      }
      default: {
        // 未知消息类型：忽略（协议演进容错）
        return;
      }
    }
  } catch (err) {
    ctx.postMessage({
      type: 'error',
      requestId: (req as { requestId?: string }).requestId ?? '',
      message: err instanceof Error ? err.message : String(err),
    });
  }
}

ctx.addEventListener('message', (ev: MessageEvent<WorkerRequest>) => {
  handleRequest(ev.data);
});
