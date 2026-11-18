/**
 * 全量数据契约（唯一类型来源）。
 *
 * 约定（见架构定稿 §4 / 附 6.1）：
 * - `displayText` 是原始日志进入 DOM / 搜索索引 / 导出报告的唯一文本闸门；
 * - 导出报告走 `SanitizedEvent`（5 字段，含 displayText）；
 * - 复盘包走独立的 `ReviewItem` 严格 7 键白名单（绝不含 displayText 全文）；
 * - 两条出口白名单强度不同，不得合并（见 vite.config.ts 的 assertWhitelistDivergence 回归断言）。
 */

export type EventKind =
  | 'user_message'
  | 'assistant_message'
  | 'tool_call'
  | 'file_change'
  | 'unknown';

export type LineStatus = 'ok' | 'skipped_json' | 'skipped_non_json' | 'skipped_empty';

export type RuleWhen = 'anyPath' | 'roleEquals' | 'allPaths';

/** 文件变更类型（NormalizedEvent 可选字段，见附 6.1） */
export type FileChangeKind = 'created' | 'modified' | 'deleted' | 'unknown';

/** 运行时唯一解析模式枚举（与编译期常量 NETWORK_BADGE 正交，不得合并成枚举） */
export type ParseMode = 'worker' | 'compat';

/** 剪贴板三级降级结果 */
export type CopyOutcome = 'clipboard' | 'execCommand' | 'manual';

export interface RawLine {
  lineNo: number;
  text: string;
  status: LineStatus;
  value?: Record<string, unknown>;
}

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

export interface NormalizedEvent {
  seq: number;
  kind: EventKind;
  /** 毫秒 epoch；解析失败为 null，排序用 null → Infinity 兜底 */
  timestamp: number | null;
  /** 唯一文本出口：展示 / 搜索 / 导出 / 复盘意图短句的来源 */
  displayText: string;
  /** 仅存在于内存模型，绝不投影出白名单边界 */
  toolName?: string;
  filePath?: string;
  fileChangeKind?: FileChangeKind;
  usage: TokenUsage;
  dedupeKey: string | null;
  sourceLineNos: number[];
}

export interface ClassificationRule {
  kind: EventKind;
  when: RuleWhen;
  /** anyPath / allPaths 模式下参与判定的字段路径 */
  paths?: string[];
  /** roleEquals 模式下参与判定的角色取值（小写比较） */
  roles?: string[];
}

export interface FieldMap {
  timestamp: string[];
  role: string[];
  content: string[];
  toolName: string[];
  toolArgs: string[];
  filePath: string[];
  sessionId: string[];
  messageId: string[];
  requestId: string[];
  usageInput: string[];
  usageOutput: string[];
  cwd: string[];
  /** 附 6.1：通用候选路径（change_type / changeType / operation / action / edit.type），零厂商名 */
  fileChangeKind: string[];
  /** 有序分类规则：先命中先定 */
  classify: ClassificationRule[];
}

export interface ParseStats {
  totalLines: number;
  okLines: number;
  skippedLines: number;
  skippedByReason: Record<string, number>;
  byKind: Record<EventKind, number>;
  unknownCount: number;
  mergedDuplicates: number;
  /** 只允许在 dedupe 之后按事件求和（重复行合并时逐字段取 max） */
  usageTotal: TokenUsage;
  bytesRead: number;
  durationMs: number;
}

export interface MaskOptions {
  stripPaths: boolean;
  /** API Key 掩码在 UI 与导出两处强制，此开关仅作展示用途，不实际关闭掩码 */
  stripApiKeys: boolean;
  stripCode: boolean;
}

/** 导出报告白名单投影（严格 5 字段，含 displayText） */
export interface SanitizedEvent {
  seq: number;
  timestamp: number | null;
  kind: EventKind;
  displayText: string;
  usage: TokenUsage;
}

/** 复盘包白名单投影（严格 7 键，绝不含 displayText 全文；intentShort 仅由 user_message 派生） */
export interface ReviewItem {
  seq: number;
  timestamp: number | null;
  kind: EventKind;
  toolName?: string;
  fileChangeKind?: FileChangeKind;
  usage: TokenUsage;
  /** ≤80 字、已掩码的用户意图短句，仅 user_message 产出 */
  intentShort?: string;
}

export interface SearchIndex {
  /** 与事件下标一一对应的小写检索文本 */
  searchText: string[];
}

/** 复盘选择态（UI 侧实现；明细上限 200 为产品默认值，不做成可调配置） */
export interface ReviewSelection {
  seqs: Set<number>;
  readonly detailLimit: 200;
  toggle(seq: number): void;
  clear(): void;
}

export interface ReviewPackage {
  /** 确定性聚合 + 最多 200 条脱敏明细 */
  summary: string;
  /** 静态中性模板（构建期经 define 注入，零厂商名、零禁词、零禁暗示措辞） */
  prompt: string;
  aggregate: ParseStats;
  includedSeqs: number[];
  /** 超出明细上限时 UI 明示 */
  truncated: boolean;
}

export type WorkerRequest =
  | { type: 'init'; requestId: string; fieldMap: FieldMap }
  | { type: 'chunk'; requestId: string; lines: string[]; startLineNo: number }
  | { type: 'bytes'; requestId: string; bytes: number }
  | { type: 'finalize'; requestId: string }
  | { type: 'window'; requestId: string; start: number; count: number }
  | { type: 'search'; requestId: string; query: string; limit: number }
  | { type: 'export'; requestId: string; mask: MaskOptions }
  | { type: 'review'; requestId: string; seqs: number[] };

export type WorkerResponse =
  | { type: 'progress'; requestId: string; stats: ParseStats }
  | { type: 'windowRows'; requestId: string; rows: NormalizedEvent[] }
  | { type: 'done'; requestId: string; stats: ParseStats; eventCount: number }
  | { type: 'searchResult'; requestId: string; ids: number[] }
  | { type: 'report'; requestId: string; html: string }
  | { type: 'reviewPackage'; requestId: string; pkg: ReviewPackage; items: ReviewItem[] }
  | { type: 'error'; requestId: string; message: string };

/** 构建期由 vite define 注入的复盘提示词模板全局常量（parser.ts 不内嵌任何提示词字面量） */
declare global {
  // eslint-disable-next-line no-var
  const __REVIEW_PROMPT__: string;
}
