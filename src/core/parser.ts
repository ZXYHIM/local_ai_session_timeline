/**
 * 解析内核（纯函数模块）：无 DOM、无网络、无副作用、永不向调用方抛错（parseLine）。
 *
 * 关键不变量（架构定稿 §4 / 附 6.1 / §8）：
 * 1. `displayText` 是原始日志进入 DOM / 搜索索引 / 导出报告的唯一文本闸门；
 * 2. `renderReviewText(ReviewPackage)` 是复制到剪贴板的字符串唯一来源，
 *    复盘包只能由独立的 `ReviewItem` 严格 7 键白名单构建，绝不含 displayText 全文；
 * 3. 导出报告走 `sanitize()` 的 `SanitizedEvent` 5 字段白名单；
 * 4. 数据口径全局唯一：normalize → dedupe → usageTotal；重复行合并时 usage 逐字段取 max，绝不求和；
 * 5. API Key 掩码在 UI 与导出两处强制；本地路径 / 代码块掩码受开关控制（与白名单投影正交）；
 * 6. 本文件不内嵌任何提示词字面量——复盘提示词模板由构建期 define 注入（`__REVIEW_PROMPT__`）。
 */

import type {
  EventKind,
  FieldMap,
  FileChangeKind,
  MaskOptions,
  NormalizedEvent,
  ParseStats,
  RawLine,
  ReviewItem,
  ReviewPackage,
  SanitizedEvent,
  SearchIndex,
  TokenUsage,
} from './types';
// LineStatus 仅作为 parseLine 返回结构中的字段类型经 RawLine 间接引用，不在此处显式导入

/** 复盘包明细上限：产品默认值，不做成用户可调配置（架构定稿 §8） */
export const REVIEW_DETAIL_LIMIT = 200;

/** 超长行 displayText 截断阈值（4KB） */
export const DISPLAY_TEXT_MAX_LENGTH = 4096;

/** 意图短句最大长度（附 6.1：≤80 字截断） */
export const INTENT_SHORT_MAX_LENGTH = 80;

const API_KEY_PATTERN = /(sk-|api[_-]?key|Bearer\s+)\S{8,}/gi;
const LOCAL_PATH_PATTERN = /(\/Users\/|\/home\/|C:\\Users\\)[^\s"'<>]+/gi;
const FENCED_CODE_PATTERN = /```[\s\S]*?```/g;

const KIND_TEXT: Record<EventKind, string> = {
  user_message: '用户消息',
  assistant_message: '助手消息',
  tool_call: '工具调用',
  file_change: '文件变更',
  unknown: '未知类型',
};

// ---------------------------------------------------------------------------
// 统计
// ---------------------------------------------------------------------------

export function createEmptyStats(): ParseStats {
  return {
    totalLines: 0,
    okLines: 0,
    skippedLines: 0,
    skippedByReason: {},
    byKind: {
      user_message: 0,
      assistant_message: 0,
      tool_call: 0,
      file_change: 0,
      unknown: 0,
    },
    unknownCount: 0,
    mergedDuplicates: 0,
    usageTotal: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
    bytesRead: 0,
    durationMs: 0,
  };
}

export function cloneStats(stats: ParseStats): ParseStats {
  return {
    ...stats,
    skippedByReason: { ...stats.skippedByReason },
    byKind: { ...stats.byKind },
    usageTotal: { ...stats.usageTotal },
  };
}

/** 只允许在 dedupe 之后调用：对已去重事件逐字段求和 */
export function computeUsageTotal(events: readonly NormalizedEvent[]): TokenUsage {
  const total: TokenUsage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
  for (const ev of events) {
    total.inputTokens += ev.usage.inputTokens;
    total.outputTokens += ev.usage.outputTokens;
    total.totalTokens += ev.usage.totalTokens;
  }
  return total;
}

// ---------------------------------------------------------------------------
// 通用取值
// ---------------------------------------------------------------------------

/** 按优先级依次试点号路径（支持 a.b[0].c），首个非 null/''/undefined 即用 */
export function getByPath(
  obj: Record<string, unknown> | null | undefined,
  candidates: readonly string[],
): unknown {
  if (obj === null || obj === undefined) return null;
  for (const candidate of candidates) {
    const value = resolvePath(obj, candidate);
    if (value !== null && value !== undefined && value !== '') return value;
  }
  return null;
}

function resolvePath(root: Record<string, unknown>, pathExpr: string): unknown {
  let current: unknown = root;
  const tokens = pathExpr.split('.');
  for (const token of tokens) {
    if (current === null || current === undefined) return null;
    let key = token;
    let rest: string | null = null;
    const bracket = token.indexOf('[');
    if (bracket >= 0) {
      key = token.slice(0, bracket);
      rest = token.slice(bracket);
    }
    if (typeof current !== 'object' || Array.isArray(current)) return null;
    const record = current as Record<string, unknown>;
    if (!Object.prototype.hasOwnProperty.call(record, key)) return null;
    current = record[key];
    while (rest !== null) {
      const match = /^\[(\d+)\](.*)$/.exec(rest);
      if (match === null || !Array.isArray(current)) return null;
      const index = Number(match[1]);
      if (index < 0 || index >= current.length) return null;
      current = current[index];
      rest = match[2] === '' ? null : match[2];
    }
  }
  return current === undefined ? null : current;
}

function getString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function toNonNegativeNumber(value: unknown): number {
  const num = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(num) && num > 0 ? Math.round(num) : 0;
}

/** 内容字段 → 展示文本：兼容字符串 / 文本数组 / {text} / {content} 嵌套 */
export function contentToText(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) {
    const parts: string[] = [];
    for (const item of value) {
      const text = contentToText(item);
      if (text !== '') parts.push(text);
    }
    return parts.join('\n');
  }
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const text = contentToText(record.text);
    if (text !== '') return text;
    return contentToText(record.content);
  }
  return '';
}

/** 时间戳归一到毫秒 epoch；失败为 null */
export function parseTimestamp(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'number' && Number.isFinite(value)) {
    return normalizeEpoch(value);
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed === '') return null;
    const isNumericString = /^[+-]?\d+(\.\d+)?$/.test(trimmed);
    if (isNumericString) return normalizeEpoch(Number(trimmed));
    const parsed = Date.parse(trimmed);
    return Number.isNaN(parsed) ? null : parsed;
  }
  return null;
}

function normalizeEpoch(value: number): number | null {
  if (!Number.isFinite(value) || value <= 0) return null;
  if (value > 1e12) return Math.round(value); // 已是毫秒
  if (value > 1e9) return Math.round(value * 1000); // 秒 → 毫秒
  return null; // 明显不是时间戳
}

// ---------------------------------------------------------------------------
// 脱敏（唯一实现点）
// ---------------------------------------------------------------------------

/** API Key 掩码：UI 与导出两处强制，不受开关控制 */
export function maskSensitiveKeys(text: string): string {
  return text.replace(API_KEY_PATTERN, '***');
}

/** 组合脱敏：API Key 强制；本地路径 / 代码块受 MaskOptions 控制 */
export function maskText(text: string, mask: MaskOptions): string {
  let result = maskSensitiveKeys(text);
  if (mask.stripPaths) result = result.replace(LOCAL_PATH_PATTERN, '<path>');
  if (mask.stripCode) result = result.replace(FENCED_CODE_PATTERN, '[code omitted]');
  return result;
}

// ---------------------------------------------------------------------------
// 解析与归一
// ---------------------------------------------------------------------------

/** 单行解析：永不 throw；脏数据只计入状态，绝不中断整条管线 */
export function parseLine(text: string, lineNo: number): RawLine {
  if (text.trim() === '') {
    return { lineNo, text, status: 'skipped_empty' };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { lineNo, text, status: 'skipped_non_json' };
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { lineNo, text, status: 'skipped_json' };
  }
  return { lineNo, text, status: 'ok', value: parsed as Record<string, unknown> };
}

/** 有序分类：先命中先定；全部未命中 → unknown */
export function classifyEvent(value: Record<string, unknown>, fieldMap: FieldMap): EventKind {
  for (const rule of fieldMap.classify) {
    if (rule.when === 'roleEquals') {
      const role = getByPath(value, fieldMap.role);
      if (typeof role === 'string' && rule.roles !== undefined) {
        if (rule.roles.includes(role.trim().toLowerCase())) return rule.kind;
      }
    } else if (rule.when === 'anyPath') {
      if (rule.paths !== undefined && rule.paths.some((p) => getByPath(value, [p]) !== null)) {
        return rule.kind;
      }
    } else if (rule.when === 'allPaths') {
      if (
        rule.paths !== undefined &&
        rule.paths.length > 0 &&
        rule.paths.every((p) => getByPath(value, [p]) !== null)
      ) {
        return rule.kind;
      }
    }
  }
  return 'unknown';
}

function normalizeFileChangeKind(value: unknown): FileChangeKind {
  const text = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (text === '') return 'unknown';
  if (text.includes('creat') || text.includes('add') || text.includes('new')) return 'created';
  if (text.includes('delet') || text.includes('remov')) return 'deleted';
  if (
    text.includes('modif') ||
    text.includes('edit') ||
    text.includes('writ') ||
    text.includes('updat') ||
    text.includes('chang') ||
    text.includes('patch')
  ) {
    return 'modified';
  }
  return 'unknown';
}

function truncateDisplayText(text: string): string {
  if (text.length <= DISPLAY_TEXT_MAX_LENGTH) return text;
  return `${text.slice(0, DISPLAY_TEXT_MAX_LENGTH)} [truncated]`;
}

/** 归一化：候选路径 fallback + 有序分类 + usage / dedupeKey / fileChangeKind 提取 */
export function normalize(raw: RawLine, fieldMap: FieldMap, seq = 0): NormalizedEvent {
  const value = raw.value ?? {};
  const kind = classifyEvent(value, fieldMap);
  const toolName = getString(getByPath(value, fieldMap.toolName));
  const filePath = getString(getByPath(value, fieldMap.filePath));

  let displayText = '';
  if (kind === 'unknown') {
    // unknown 的「原样保留」只在内存模型内（displayText 存原文、已掩码）
    displayText = raw.text;
  } else {
    displayText = contentToText(getByPath(value, fieldMap.content));
    if (displayText === '') {
      if (toolName !== '') displayText = toolName + (filePath !== '' ? ` ${filePath}` : '');
      else if (filePath !== '') displayText = filePath;
    }
  }
  displayText = truncateDisplayText(maskSensitiveKeys(displayText));

  const messageId = getString(getByPath(value, fieldMap.messageId));
  const sessionId = getString(getByPath(value, fieldMap.sessionId));
  const requestId = getString(getByPath(value, fieldMap.requestId));
  let dedupeKey: string | null = null;
  if (messageId !== '') dedupeKey = messageId;
  else if (sessionId !== '' && requestId !== '') dedupeKey = `${sessionId}:${requestId}`;

  const inputTokens = toNonNegativeNumber(getByPath(value, fieldMap.usageInput));
  const outputTokens = toNonNegativeNumber(getByPath(value, fieldMap.usageOutput));
  const usage: TokenUsage = {
    inputTokens,
    outputTokens,
    totalTokens: inputTokens + outputTokens,
  };

  const event: NormalizedEvent = {
    seq,
    kind,
    timestamp: parseTimestamp(getByPath(value, fieldMap.timestamp)),
    displayText,
    usage,
    dedupeKey,
    sourceLineNos: [raw.lineNo],
  };
  if (toolName !== '') event.toolName = toolName;
  if (filePath !== '') event.filePath = filePath;
  if (kind === 'file_change') {
    event.fileChangeKind = normalizeFileChangeKind(getByPath(value, fieldMap.fileChangeKind));
  }
  return event;
}

// ---------------------------------------------------------------------------
// 去重合并（usage 逐字段 max，绝不 sum）
// ---------------------------------------------------------------------------

export function mergeEvents(a: NormalizedEvent, b: NormalizedEvent): NormalizedEvent {
  const displayText =
    a.displayText.includes(b.displayText) || b.displayText.includes(a.displayText)
      ? a.displayText.length >= b.displayText.length
        ? a.displayText
        : b.displayText
      : `${a.displayText}\n${b.displayText}`;

  const timestamp =
    a.timestamp !== null && b.timestamp !== null
      ? Math.min(a.timestamp, b.timestamp)
      : a.timestamp !== null
        ? a.timestamp
        : b.timestamp;

  const sourceLineNos = Array.from(new Set([...a.sourceLineNos, ...b.sourceLineNos])).sort(
    (x, y) => x - y,
  );

  const merged: NormalizedEvent = {
    seq: a.seq,
    kind: a.kind !== 'unknown' ? a.kind : b.kind,
    timestamp,
    displayText: truncateDisplayText(maskSensitiveKeys(displayText)),
    usage: {
      inputTokens: Math.max(a.usage.inputTokens, b.usage.inputTokens),
      outputTokens: Math.max(a.usage.outputTokens, b.usage.outputTokens),
      totalTokens: Math.max(a.usage.totalTokens, b.usage.totalTokens),
    },
    dedupeKey: a.dedupeKey ?? b.dedupeKey,
    sourceLineNos,
  };
  if (a.toolName !== undefined || b.toolName !== undefined) {
    merged.toolName = a.toolName ?? b.toolName;
  }
  if (a.filePath !== undefined || b.filePath !== undefined) {
    merged.filePath = a.filePath ?? b.filePath;
  }
  if (a.fileChangeKind !== undefined || b.fileChangeKind !== undefined) {
    merged.fileChangeKind = a.fileChangeKind ?? b.fileChangeKind;
  }
  return merged;
}

export function dedupe(events: readonly NormalizedEvent[]): {
  events: NormalizedEvent[];
  mergedDuplicates: number;
} {
  const positionByKey = new Map<string, number>();
  const result: NormalizedEvent[] = [];
  let merged = 0;
  for (const ev of events) {
    if (ev.dedupeKey === null) {
      result.push(ev);
      continue;
    }
    const index = positionByKey.get(ev.dedupeKey);
    if (index === undefined) {
      positionByKey.set(ev.dedupeKey, result.length);
      result.push(ev);
    } else {
      result[index] = mergeEvents(result[index], ev);
      merged += 1;
    }
  }
  return { events: result, mergedDuplicates: merged };
}

/**
 * finalize 阶段统一入口：dedupe → 按 (timestamp ?? Infinity, 首行号) 稳定排序 → 重编 seq。
 * Worker 路径与主线程兼容路径共用，保证两条路径输出逐字段一致。
 */
export function finalizeEvents(rawEvents: readonly NormalizedEvent[]): {
  events: NormalizedEvent[];
  mergedDuplicates: number;
} {
  const deduped = dedupe(rawEvents);
  const sorted = deduped.events.slice().sort((a, b) => {
    const ta = a.timestamp ?? Infinity;
    const tb = b.timestamp ?? Infinity;
    if (ta !== tb) return ta - tb;
    return (a.sourceLineNos[0] ?? 0) - (b.sourceLineNos[0] ?? 0);
  });
  sorted.forEach((ev, i) => {
    ev.seq = i + 1;
  });
  return { events: sorted, mergedDuplicates: deduped.mergedDuplicates };
}

// ---------------------------------------------------------------------------
// 搜索
// ---------------------------------------------------------------------------

export function buildIndex(events: readonly NormalizedEvent[]): SearchIndex {
  return { searchText: events.map((ev) => ev.displayText.toLowerCase()) };
}

export function search(index: SearchIndex, query: string, limit: number): number[] {
  const q = query.trim().toLowerCase();
  if (q === '' || limit <= 0) return [];
  const ids: number[] = [];
  for (let i = 0; i < index.searchText.length && ids.length < limit; i += 1) {
    if (index.searchText[i].includes(q)) ids.push(i + 1);
  }
  return ids;
}

// ---------------------------------------------------------------------------
// HTML 转义与导出报告（SanitizedEvent 白名单）
// ---------------------------------------------------------------------------

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (ch) => {
    switch (ch) {
      case '&':
        return '&amp;';
      case '<':
        return '&lt;';
      case '>':
        return '&gt;';
      case '"':
        return '&quot;';
      default:
        return '&#39;';
    }
  });
}

/** 导出报告白名单投影：严格 5 字段，raw/路径/参数/各类 ID 一律不投影 */
export function sanitize(event: NormalizedEvent, mask: MaskOptions): SanitizedEvent {
  return {
    seq: event.seq,
    timestamp: event.timestamp,
    kind: event.kind,
    displayText: maskText(event.displayText, mask),
    usage: { ...event.usage },
  };
}

const REPORT_STYLE = [
  ':root{color-scheme:light}',
  'body{font-family:-apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei","Segoe UI",sans-serif;margin:0 auto;max-width:920px;padding:24px 16px 64px;color:#1f2328;background:#fff}',
  'h1{font-size:20px;margin:0 0 4px}',
  'p.note{color:#57606a;font-size:13px;margin:4px 0 16px}',
  'section.stats{border:1px solid #d0d7de;border-radius:8px;padding:12px 16px;margin-bottom:20px;font-size:13px;line-height:1.9}',
  'details.ev{border:1px solid #d0d7de;border-radius:8px;margin:8px 0;padding:6px 12px}',
  'details.ev summary{cursor:pointer;font-size:13px;color:#1f2328;word-break:break-all}',
  'details.ev pre{background:#f6f8fa;border-radius:6px;padding:10px;font-size:12px;white-space:pre-wrap;word-break:break-all;overflow-wrap:anywhere}',
].join('\n');

/** 导出离线报告：纯 HTML 字符串，0 外链、0 URL、0 mailto、无 NC 声明、无脚本（折叠用 details 原生能力） */
export function renderReport(
  events: readonly SanitizedEvent[],
  stats: ParseStats,
  mask: MaskOptions,
): string {
  // 白名单结构校验：renderReport 只接受 SanitizedEvent[]（与 renderReviewText 不共用序列化函数）
  for (const ev of events) {
    if (typeof ev !== 'object' || ev === null || typeof ev.displayText !== 'string') {
      throw new TypeError('renderReport 只接受 SanitizedEvent[]（导出报告白名单结构）');
    }
  }
  const esc = escapeHtml;
  const maskNote = `路径脱敏 ${mask.stripPaths ? '开' : '关'}；API Key 掩码 强制开；代码块脱敏 ${mask.stripCode ? '开' : '关'}`;
  const statsLines = [
    `总行数：${stats.totalLines}；成功解析：${stats.okLines}；跳过：${stats.skippedLines}（非 JSON ${stats.skippedByReason['skipped_non_json'] ?? 0} / 非对象 ${stats.skippedByReason['skipped_json'] ?? 0} / 空行 ${stats.skippedByReason['skipped_empty'] ?? 0}）`,
    `事件分布：用户消息 ${stats.byKind.user_message} / 助手消息 ${stats.byKind.assistant_message} / 工具调用 ${stats.byKind.tool_call} / 文件变更 ${stats.byKind.file_change} / 未知类型 ${stats.byKind.unknown}`,
    `流式重复合并：${stats.mergedDuplicates} 条；用量合计（去重后）：输入 ${stats.usageTotal.inputTokens} / 输出 ${stats.usageTotal.outputTokens} / 总计 ${stats.usageTotal.totalTokens} tokens`,
    `读取 ${stats.bytesRead} 字节，解析耗时 ${stats.durationMs} ms`,
    `脱敏选项：${maskNote}`,
  ].map((line) => `<div>${esc(line)}</div>`).join('\n');

  const rows = events
    .map((ev) => {
      const time = ev.timestamp === null ? '-' : new Date(ev.timestamp).toISOString();
      const summaryLine = `#${ev.seq} · ${time} · ${KIND_TEXT[ev.kind]} · tokens 输入 ${ev.usage.inputTokens} / 输出 ${ev.usage.outputTokens} / 总计 ${ev.usage.totalTokens}`;
      return `<details class="ev"><summary>${esc(summaryLine)}</summary><pre>${esc(ev.displayText)}</pre></details>`;
    })
    .join('\n');

  return [
    '<!DOCTYPE html>',
    '<html lang="zh-CN">',
    '<head>',
    '<meta charset="UTF-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    '<meta name="referrer" content="no-referrer">',
    '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; style-src \'unsafe-inline\'; connect-src \'none\'; img-src \'none\'; font-src \'none\'">',
    '<title>会话统计报告（脱敏）</title>',
    `<style>${REPORT_STYLE}</style>`,
    '</head>',
    '<body>',
    '<h1>会话统计报告（脱敏）</h1>',
    '<p class="note">本报告由本地工具生成，仅含字段白名单投影后的脱敏文本；生成过程无任何网络请求。</p>',
    `<section class="stats">${statsLines}</section>`,
    rows,
    '</body>',
    '</html>',
    '',
  ].join('\n');
}

// ---------------------------------------------------------------------------
// 复盘包（ReviewItem 严格 7 键白名单，与导出报告白名单独立）
// ---------------------------------------------------------------------------

function resolveReviewPrompt(): string {
  // 构建期由 define 注入；构建期回归断言运行时经 globalThis 提供
  return typeof __REVIEW_PROMPT__ !== 'undefined' ? __REVIEW_PROMPT__ : '';
}

/** 复盘包白名单投影：严格 7 键；intentShort 仅由 user_message 派生（全量掩码 + ≤80 字截断） */
export function toReviewItem(event: NormalizedEvent): ReviewItem {
  const item: ReviewItem = {
    seq: event.seq,
    timestamp: event.timestamp,
    kind: event.kind,
    usage: { ...event.usage },
  };
  if (event.toolName !== undefined && event.toolName !== '') item.toolName = event.toolName;
  if (event.kind === 'file_change') item.fileChangeKind = event.fileChangeKind ?? 'unknown';
  if (event.kind === 'user_message') {
    const masked = maskText(event.displayText, {
      stripPaths: true,
      stripApiKeys: true,
      stripCode: true,
    });
    item.intentShort = masked.slice(0, INTENT_SHORT_MAX_LENGTH);
  }
  return item;
}

function renderReviewSummary(
  items: readonly ReviewItem[],
  stats: ParseStats,
  selectedTotal: number,
): string {
  const lines: string[] = [];
  lines.push('【会话整体统计（口径：归一 → 去重 → 统计；重复行合并时用量逐字段取最大值）】');
  lines.push(
    `总行数 ${stats.totalLines}；成功 ${stats.okLines}；跳过 ${stats.skippedLines}（非JSON ${stats.skippedByReason['skipped_non_json'] ?? 0}、非对象 ${stats.skippedByReason['skipped_json'] ?? 0}、空行 ${stats.skippedByReason['skipped_empty'] ?? 0}）`,
  );
  lines.push(
    `事件分布：用户消息 ${stats.byKind.user_message}；助手消息 ${stats.byKind.assistant_message}；工具调用 ${stats.byKind.tool_call}；文件变更 ${stats.byKind.file_change}；未知类型 ${stats.byKind.unknown}`,
  );
  lines.push(`流式重复合并 ${stats.mergedDuplicates} 条`);
  lines.push(
    `用量合计：输入 ${stats.usageTotal.inputTokens} / 输出 ${stats.usageTotal.outputTokens} / 总计 ${stats.usageTotal.totalTokens} tokens`,
  );
  lines.push(`读取 ${stats.bytesRead} 字节，解析耗时 ${stats.durationMs} ms`);
  lines.push(
    `【选中条目】共 ${selectedTotal} 条${selectedTotal > items.length ? `，超出明细上限 ${REVIEW_DETAIL_LIMIT} 条：仅前 ${items.length} 条进入明细，其余只计入上方聚合（已截断）` : '，全部纳入明细'}`,
  );
  lines.push('【脱敏明细（字段白名单：序号 / 时间 / 事件类型 / 工具名 / 变更类型 / 用量 / 意图短句）】');
  for (const item of items) {
    const time = item.timestamp === null ? '-' : new Date(item.timestamp).toISOString();
    const parts = [`#${item.seq}`, `[${time}]`, KIND_TEXT[item.kind]];
    if (item.toolName !== undefined) parts.push(`工具=${item.toolName}`);
    if (item.fileChangeKind !== undefined) parts.push(`变更=${item.fileChangeKind}`);
    parts.push(
      `tokens 输入${item.usage.inputTokens}/输出${item.usage.outputTokens}/总计${item.usage.totalTokens}`,
    );
    if (item.intentShort !== undefined) parts.push(`意图：${item.intentShort}`);
    lines.push(parts.join(' | '));
  }
  return lines.join('\n');
}

/**
 * 构建复盘包：纯确定性函数（同输入同输出）。
 * 输入为内存中的 NormalizedEvent 与选择 seq 集合；输出只经 ReviewItem 白名单投影。
 */
export function buildReviewPackage(
  events: readonly NormalizedEvent[],
  stats: ParseStats,
  selection: { seqs: Iterable<number> },
): ReviewPackage {
  const wanted = new Set(selection.seqs);
  const selected = events.filter((ev) => wanted.has(ev.seq)).sort((a, b) => a.seq - b.seq);
  const items = selected.map(toReviewItem);
  const details = items.slice(0, REVIEW_DETAIL_LIMIT);
  const truncated = items.length > REVIEW_DETAIL_LIMIT;
  return {
    summary: renderReviewSummary(details, stats, items.length),
    prompt: resolveReviewPrompt(),
    aggregate: stats,
    includedSeqs: details.map((item) => item.seq),
    truncated,
  };
}

/** 复制到剪贴板的字符串唯一来源：只接受 ReviewPackage（复盘包白名单结构） */
export function renderReviewText(pkg: ReviewPackage): string {
  if (
    typeof pkg !== 'object' ||
    pkg === null ||
    typeof pkg.summary !== 'string' ||
    typeof pkg.prompt !== 'string' ||
    typeof pkg.aggregate !== 'object' ||
    pkg.aggregate === null ||
    !Array.isArray(pkg.includedSeqs) ||
    typeof pkg.truncated !== 'boolean'
  ) {
    throw new TypeError(
      'renderReviewText 只接受 ReviewPackage（复盘包白名单结构），不接受事件列表或对话数据',
    );
  }
  return `${pkg.prompt}\n\n${pkg.summary}`;
}
