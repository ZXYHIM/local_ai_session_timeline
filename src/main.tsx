/**
 * React 入口 + 全部 UI：
 * 选文件/拖放（只接受 1 个文件）、虚拟时间线（DOM 节点数恒定）、统计条、
 * 搜索（120ms debounce、上限 500）、脱敏导出、复盘包选择态与逐条预览/确认/三级复制降级。
 *
 * 红线（架构定稿 §8 / 附 6.3）：
 * - NETWORK_BADGE 是编译期常量静态 span；ParseMode 是唯一运行时状态，两者正交；
 * - 禁用 navigator.onLine 与 online/offline 监听；
 * - 无任何持久化（localStorage / IndexedDB / Cookie / Service Worker 全禁），刷新即释放；
 * - 未点「确认生成」前不产生任何可复制文本；明细上限 200 条不可调；
 * - UI 必须写明「本工具不调用任何模型；摘要与提示词由本地算法生成，请复制到你自己的账号执行」。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { DEFAULT_FIELD_MAP } from './core/fieldMap';
import { createParserRunner, download } from './core/engine';
import type { ParserRunner } from './core/engine';
import { maskText, renderReviewText, REVIEW_DETAIL_LIMIT } from './core/parser';
import type {
  CopyOutcome,
  EventKind,
  MaskOptions,
  NormalizedEvent,
  ParseMode,
  ParseStats,
  ReviewItem,
  ReviewPackage,
} from './core/types';

/** 编译期常量：静态 span，无开关（与 ParseMode 运行时状态正交，不合并成枚举） */
const NETWORK_BADGE = '离线 · 本工具从不联网';

/** 红线 12 逐字措辞 */
const MODEL_DISCLAIMER =
  '本工具不调用任何模型；摘要与提示词由本地算法生成，请复制到你自己的账号执行。';

const ROW_HEIGHT = 64;
const OVERSCAN = 6;
const SEARCH_DEBOUNCE_MS = 120;
const SEARCH_LIMIT = 500;

const KIND_LABEL: Record<EventKind, string> = {
  user_message: '用户',
  assistant_message: '助手',
  tool_call: '工具',
  file_change: '文件',
  unknown: '未知',
};

const timeFormatter = new Intl.DateTimeFormat('zh-CN', {
  hour12: false,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
});

function formatTime(ts: number): string {
  return timeFormatter.format(new Date(ts));
}

function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${bytes} B`;
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

function reportStamp(): string {
  const d = new Date();
  return `${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}`;
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

interface ReviewData {
  pkg: ReviewPackage;
  items: ReviewItem[];
}

function App(): JSX.Element {
  const [fileName, setFileName] = useState('');
  const [parsing, setParsing] = useState(false);
  const [stats, setStats] = useState<ParseStats | null>(null);
  const [eventCount, setEventCount] = useState(0);
  const [mode, setMode] = useState<ParseMode | null>(null);
  const [rows, setRows] = useState<NormalizedEvent[]>([]);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(480);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchIds, setSearchIds] = useState<number[]>([]);
  const [mask, setMask] = useState<MaskOptions>({
    stripPaths: true,
    stripApiKeys: true,
    stripCode: true,
  });
  const [selectedSeqs, setSelectedSeqs] = useState<Set<number>>(new Set());
  const [review, setReview] = useState<ReviewData | null>(null);
  const [copyOutcome, setCopyOutcome] = useState<CopyOutcome | null>(null);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const [dragOver, setDragOver] = useState(false);

  const runnerRef = useRef<ParserRunner | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const manualCopyRef = useRef<HTMLTextAreaElement>(null);

  const searchHitSet = useMemo(() => new Set(searchIds), [searchIds]);
  const reviewText = useMemo(() => (review === null ? '' : renderReviewText(review.pkg)), [review]);

  // ------------------------------------------------------------------
  // 文件接入（只接受 1 个文件；多文件提示且不读）
  // ------------------------------------------------------------------

  const handleFiles = useCallback((files: FileList | File[]): void => {
    const list = Array.from(files);
    if (list.length === 0) return;
    if (list.length > 1) {
      setError('一次只接受 1 个文件：已忽略全部所选文件（未读取任何内容），请重新选择单个文件。');
      return;
    }
    const file = list[0];
    runnerRef.current?.dispose();
    runnerRef.current = null;
    setFileName(file.name);
    setParsing(true);
    setStats(null);
    setEventCount(0);
    setMode(null);
    setRows([]);
    setScrollTop(0);
    setSearchQuery('');
    setSearchIds([]);
    setSelectedSeqs(new Set());
    setReview(null);
    setCopyOutcome(null);
    setNotice('');
    setError('');
    const runner = createParserRunner(file, DEFAULT_FIELD_MAP, {
      onProgress: (s) => setStats(s),
      onDone: (s, count) => {
        setStats(s);
        setEventCount(count);
        setParsing(false);
      },
      onWindowRows: (r) => setRows(r),
      onSearchResult: (ids) => setSearchIds(ids),
      onModeChange: (m) => setMode(m),
      onError: (m) => {
        setError(m);
        setParsing(false);
      },
    });
    runnerRef.current = runner;
  }, []);

  // ------------------------------------------------------------------
  // 虚拟窗口请求
  // ------------------------------------------------------------------

  const requestVisibleWindow = useCallback(
    (top: number, height: number): void => {
      const runner = runnerRef.current;
      if (runner === null || eventCount === 0) return;
      const start = Math.max(0, Math.floor(top / ROW_HEIGHT) - OVERSCAN);
      const count = Math.ceil(height / ROW_HEIGHT) + OVERSCAN * 2;
      runner.requestWindow(start, count);
    },
    [eventCount],
  );

  const handleScroll = useCallback((): void => {
    const el = listRef.current;
    if (el === null) return;
    setScrollTop(el.scrollTop);
    requestVisibleWindow(el.scrollTop, el.clientHeight);
  }, [requestVisibleWindow]);

  useEffect(() => {
    const el = listRef.current;
    if (el !== null) setViewportHeight(el.clientHeight);
    const onResize = (): void => {
      const node = listRef.current;
      if (node !== null) {
        setViewportHeight(node.clientHeight);
        requestVisibleWindow(node.scrollTop, node.clientHeight);
      }
    };
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [requestVisibleWindow]);

  useEffect(() => {
    requestVisibleWindow(scrollTop, viewportHeight);
  }, [eventCount, requestVisibleWindow, scrollTop, viewportHeight]);

  // ------------------------------------------------------------------
  // 搜索（debounce 120ms，上限 500）
  // ------------------------------------------------------------------

  useEffect(() => {
    if (searchQuery.trim() === '') {
      setSearchIds([]);
      return;
    }
    const timer = window.setTimeout(() => {
      runnerRef.current?.requestSearch(searchQuery, SEARCH_LIMIT);
    }, SEARCH_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [searchQuery]);

  const jumpToFirstHit = useCallback((): void => {
    if (searchIds.length === 0) return;
    const el = listRef.current;
    if (el === null) return;
    const firstSeq = Math.min(...searchIds);
    el.scrollTop = (firstSeq - 1) * ROW_HEIGHT;
    setScrollTop(el.scrollTop);
    requestVisibleWindow(el.scrollTop, el.clientHeight);
  }, [searchIds, requestVisibleWindow]);

  // ------------------------------------------------------------------
  // 时间线键盘滚动（↑/↓/PageUp/PageDown/Home/End）
  // ------------------------------------------------------------------

  const handleListKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>): void => {
      const el = listRef.current;
      if (el === null) return;
      const page = el.clientHeight;
      let next = el.scrollTop;
      switch (e.key) {
        case 'ArrowDown':
          next += ROW_HEIGHT;
          break;
        case 'ArrowUp':
          next -= ROW_HEIGHT;
          break;
        case 'PageDown':
          next += page;
          break;
        case 'PageUp':
          next -= page;
          break;
        case 'Home':
          next = 0;
          break;
        case 'End':
          next = el.scrollHeight;
          break;
        default:
          return;
      }
      e.preventDefault();
      el.scrollTop = next;
      setScrollTop(next);
      requestVisibleWindow(next, el.clientHeight);
    },
    [requestVisibleWindow],
  );

  // ------------------------------------------------------------------
  // 导出报告（三项脱敏默认全开；API Key 掩码强制）
  // ------------------------------------------------------------------

  const handleExport = useCallback(async (): Promise<void> => {
    const runner = runnerRef.current;
    if (runner === null || eventCount === 0) return;
    try {
      const html = await runner.requestExport(mask);
      download(html, `session-report-${reportStamp()}.html`);
      setNotice('报告已写入本机文件（仅本机文件写入，内容仍在本设备，且只承载脱敏后文本）。');
      setError('');
    } catch (err) {
      setError(`导出失败：${messageOf(err)}`);
    }
  }, [eventCount, mask]);

  // ------------------------------------------------------------------
  // 复盘包：选择 → 确认生成（显式确认门）→ 逐条预览/取消 → 一键复制（三级降级）
  // ------------------------------------------------------------------

  const toggleReview = useCallback((seq: number): void => {
    setSelectedSeqs((prev) => {
      const next = new Set(prev);
      if (next.has(seq)) next.delete(seq);
      else next.add(seq);
      return next;
    });
  }, []);

  const fetchReview = useCallback(async (seqs: number[]): Promise<void> => {
    const runner = runnerRef.current;
    if (runner === null || seqs.length === 0) return;
    try {
      const bundle = await runner.requestReview(seqs);
      setReview(bundle);
      setError('');
    } catch (err) {
      setError(`生成复盘包失败：${messageOf(err)}`);
    }
  }, []);

  const confirmReview = useCallback((): void => {
    if (selectedSeqs.size === 0) return;
    setCopyOutcome(null);
    void fetchReview([...selectedSeqs].sort((a, b) => a - b));
  }, [selectedSeqs, fetchReview]);

  /** 逐条取消：摘要 / 提示词同步减少 */
  const cancelReviewItem = useCallback(
    (seq: number): void => {
      setSelectedSeqs((prev) => {
        const next = new Set(prev);
        next.delete(seq);
        if (next.size === 0) {
          setReview(null);
          setCopyOutcome(null);
          return next;
        }
        void fetchReview([...next].sort((a, b) => a - b));
        return next;
      });
    },
    [fetchReview],
  );

  /** 三级复制降级：navigator.clipboard → 临时 textarea + execCommand('copy') → 只读 textarea 手动 ⌘C */
  const copyReview = useCallback(async (): Promise<void> => {
    if (review === null) return;
    const text = renderReviewText(review.pkg);
    // 第一级：navigator.clipboard（需用户手势；file:// 在 Chrome 为 secure context，Safari/Firefox 不可依赖）
    try {
      if (typeof navigator !== 'undefined' && navigator.clipboard !== undefined && typeof navigator.clipboard.writeText === 'function') {
        await navigator.clipboard.writeText(text);
        setCopyOutcome('clipboard');
        setNotice('已写入本机剪贴板（脱敏后文本），请自行确认脱敏结果。');
        return;
      }
    } catch {
      // 降级，不视为错误
    }
    // 第二级：临时 textarea + execCommand('copy')（用完 remove 并清空 value）
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.top = '0';
    ta.style.left = '0';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    let ok = false;
    try {
      ok = document.execCommand('copy');
    } catch {
      ok = false;
    }
    document.body.removeChild(ta);
    ta.value = '';
    if (ok) {
      setCopyOutcome('execCommand');
      setNotice('已通过降级方式写入本机剪贴板（脱敏后文本），请自行确认脱敏结果。');
      return;
    }
    // 第三级：只读 textarea 全选，手动 ⌘C
    setCopyOutcome('manual');
    setNotice('剪贴板 API 与降级复制均不可用：已全选文本，请按 ⌘C / Ctrl+C 手动复制。');
    window.setTimeout(() => {
      manualCopyRef.current?.focus();
      manualCopyRef.current?.select();
    }, 0);
  }, [review]);

  // ------------------------------------------------------------------
  // 渲染
  // ------------------------------------------------------------------

  const firstVisible = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN);
  const lastVisible = Math.min(
    eventCount,
    Math.ceil((scrollTop + viewportHeight) / ROW_HEIGHT) + OVERSCAN,
  );
  const visibleRows = rows.filter((r) => r.seq >= firstVisible + 1 && r.seq <= lastVisible);

  return (
    <div className="app">
      <header className="app-header">
        <div className="title-row">
          <h1>本地 AI 会话时间线</h1>
          <span className="network-badge" aria-label="网络状态说明">{NETWORK_BADGE}</span>
          {mode !== null && (
            <span className={mode === 'worker' ? 'mode-badge' : 'mode-badge compat'}>
              {mode === 'worker' ? 'Worker 模式' : '兼容模式'}
            </span>
          )}
        </div>
        <p className="subtitle">
          拖入 AI 编码工具导出的 JSONL 会话日志，本工具在本机内存中解析、统计并渲染时间线；
          全程零网络、零上传、零留存，刷新即释放。
        </p>
      </header>

      {error !== '' && (
        <p className="alert alert-error" role="alert">{error}</p>
      )}
      {notice !== '' && (
        <p className="alert alert-info" role="status">{notice}</p>
      )}

      {fileName === '' ? (
        <div
          className={`dropzone${dragOver ? ' dragover' : ''}`}
          onDragOver={(e) => {
            e.preventDefault();
            setDragOver(true);
          }}
          onDragLeave={() => setDragOver(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDragOver(false);
            handleFiles(e.dataTransfer.files);
          }}
        >
          <p className="dropzone-title">拖入 1 个 JSONL / NDJSON / TXT 文件</p>
          <p className="dropzone-note">或点击下方按钮选择文件（一次只接受 1 个，不自动读取任何其他文件）</p>
          <label className="file-button" htmlFor="file-input">
            选择文件
            <input
              id="file-input"
              type="file"
              accept=".jsonl,.ndjson,.txt"
              onChange={(e) => {
                if (e.target.files !== null) handleFiles(e.target.files);
                e.target.value = '';
              }}
            />
          </label>
        </div>
      ) : (
        <main className="workspace">
          <div className="toolbar">
            <span className="file-name" title={fileName}>{fileName}</span>
            <label className="file-button small" htmlFor="file-input2">
              换一个文件
              <input
                id="file-input2"
                type="file"
                accept=".jsonl,.ndjson,.txt"
                onChange={(e) => {
                  if (e.target.files !== null) handleFiles(e.target.files);
                  e.target.value = '';
                }}
              />
            </label>
          </div>

          {stats !== null && (
            <section className="stats-bar" aria-label="解析统计">
              <span>行数 {stats.totalLines.toLocaleString()}</span>
              <span>成功 {stats.okLines.toLocaleString()}</span>
              <span>跳过 {stats.skippedLines.toLocaleString()}</span>
              <span>未知 {stats.unknownCount.toLocaleString()}</span>
              <span>重复合并 {stats.mergedDuplicates.toLocaleString()}</span>
              <span>
                tokens 入 {stats.usageTotal.inputTokens.toLocaleString()} / 出{' '}
                {stats.usageTotal.outputTokens.toLocaleString()} / 计{' '}
                {stats.usageTotal.totalTokens.toLocaleString()}
              </span>
              <span>{formatBytes(stats.bytesRead)}</span>
              <span>{stats.durationMs} ms</span>
              <span>事件 {eventCount.toLocaleString()}</span>
              {parsing && <span className="parsing">解析中…</span>}
            </section>
          )}

          <div className="search-row">
            <label className="search-label" htmlFor="search-input">搜索</label>
            <input
              id="search-input"
              type="text"
              className="search-input"
              placeholder="在全部事件文本中搜索（本机内存检索，120ms 防抖，最多返回 500 条）"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
            />
            <span className="search-count">
              {searchQuery.trim() === '' ? '' : `命中 ${searchIds.length} 条`}
            </span>
            <button
              type="button"
              className="ghost-button"
              onClick={jumpToFirstHit}
              disabled={searchIds.length === 0}
            >
              跳到首个命中
            </button>
          </div>

          <div
            ref={listRef}
            className="timeline"
            role="list"
            aria-label="会话事件时间线（可用方向键 / 翻页键 / Home / End 滚动）"
            tabIndex={0}
            onScroll={handleScroll}
            onKeyDown={handleListKeyDown}
          >
            <div className="timeline-inner" style={{ height: eventCount * ROW_HEIGHT }}>
              {visibleRows.map((ev) => (
                <div
                  key={ev.seq}
                  className={`row kind-${ev.kind}${searchHitSet.has(ev.seq) ? ' hit' : ''}`}
                  style={{ top: (ev.seq - 1) * ROW_HEIGHT, height: ROW_HEIGHT }}
                  role="listitem"
                >
                  <input
                    type="checkbox"
                    className="row-check"
                    aria-label={`选择第 ${ev.seq} 条事件纳入复盘包`}
                    checked={selectedSeqs.has(ev.seq)}
                    onChange={() => toggleReview(ev.seq)}
                  />
                  <span className="row-seq">#{ev.seq}</span>
                  <span className="row-time">{ev.timestamp === null ? '—' : formatTime(ev.timestamp)}</span>
                  <span className={`row-kind k-${ev.kind}`}>{KIND_LABEL[ev.kind]}</span>
                  {ev.toolName !== undefined && <span className="row-tool">{ev.toolName}</span>}
                  <span className="row-text" title={ev.displayText}>
                    {maskText(ev.displayText, mask)}
                  </span>
                </div>
              ))}
              {eventCount === 0 && (
                <p className="timeline-empty">{parsing ? '正在解析…' : '暂无事件'}</p>
              )}
            </div>
          </div>

          <section className="export-panel" aria-label="脱敏导出">
            <h2>导出离线报告（脱敏）</h2>
            <p className="muted">
              报告只经字段白名单投影输出脱敏后文本（序号 / 时间 / 类型 / 文本 / 用量）；
              报告下载仅为本机文件写入，内容仍在本设备。
            </p>
            <div className="mask-row">
              <label>
                <input
                  type="checkbox"
                  checked={mask.stripApiKeys}
                  disabled
                  onChange={() => undefined}
                />{' '}
                API Key 掩码（强制，不可关闭）
              </label>
              <label>
                <input
                  type="checkbox"
                  checked={mask.stripPaths}
                  onChange={(e) => setMask((m) => ({ ...m, stripPaths: e.target.checked }))}
                />{' '}
                本地路径脱敏
              </label>
              <label>
                <input
                  type="checkbox"
                  checked={mask.stripCode}
                  onChange={(e) => setMask((m) => ({ ...m, stripCode: e.target.checked }))}
                />{' '}
                代码块脱敏
              </label>
              <button
                type="button"
                className="primary-button"
                onClick={() => void handleExport()}
                disabled={eventCount === 0}
              >
                导出离线报告
              </button>
            </div>
          </section>

          <section className="review-panel" aria-label="脱敏复盘包">
            <h2>脱敏复盘包</h2>
            <p className="muted">{MODEL_DISCLAIMER}</p>
            <p className="muted">
              勾选时间线中的事件后点「确认生成」；生成前不产生任何可复制文本。
              明细上限 {REVIEW_DETAIL_LIMIT} 条（不可调），超出条目只计入聚合统计。
              剪贴板是工具内唯一可被带到外部应用或账号的出口，且只承载脱敏后文本。
            </p>
            <div className="review-actions">
              <span>
                已选 {selectedSeqs.size} 条
                {review !== null && review.pkg.truncated
                  ? `（已截断至 ${REVIEW_DETAIL_LIMIT} 条，其余只进聚合）`
                  : ''}
              </span>
              <button
                type="button"
                className="primary-button"
                onClick={confirmReview}
                disabled={selectedSeqs.size === 0}
              >
                确认生成
              </button>
            </div>

            {review !== null && (
              <div className="review-result">
                <h3>逐条预览（可单条取消，摘要与提示词会同步减少）</h3>
                <ul className="review-items">
                  {review.items.map((item) => (
                    <li key={item.seq} className={`review-item kind-${item.kind}`}>
                      <span className="review-item-head">
                        #{item.seq} ·{' '}
                        {item.timestamp === null ? '—' : formatTime(item.timestamp)} ·{' '}
                        {KIND_LABEL[item.kind]}
                        {item.toolName !== undefined ? ` · ${item.toolName}` : ''}
                        {item.fileChangeKind !== undefined ? ` · ${item.fileChangeKind}` : ''}
                      </span>
                      {item.intentShort !== undefined && (
                        <span className="review-item-intent">{item.intentShort}</span>
                      )}
                      <span className="review-item-usage">
                        tokens {item.usage.inputTokens}/{item.usage.outputTokens}/
                        {item.usage.totalTokens}
                      </span>
                      <button type="button" className="ghost-button" onClick={() => cancelReviewItem(item.seq)}>
                        取消这条
                      </button>
                    </li>
                  ))}
                </ul>
                <h3>复制内容预览（将写入本机剪贴板，请自行确认脱敏结果）</h3>
                <textarea className="review-text" readOnly value={reviewText} rows={12} />
                <div className="review-actions">
                  <button type="button" className="primary-button" onClick={() => void copyReview()}>
                    一键复制
                  </button>
                  {copyOutcome !== null && (
                    <span className="copy-outcome">
                      {copyOutcome === 'clipboard'
                        ? '已复制（navigator.clipboard）'
                        : copyOutcome === 'execCommand'
                          ? '已复制（execCommand 降级）'
                          : '请手动复制（见下方文本框）'}
                    </span>
                  )}
                </div>
                {copyOutcome === 'manual' && (
                  <textarea
                    ref={manualCopyRef}
                    className="review-text manual"
                    readOnly
                    value={reviewText}
                    rows={12}
                    onFocus={(e) => e.currentTarget.select()}
                  />
                )}
              </div>
            )}
          </section>
        </main>
      )}
    </div>
  );
}

const rootEl = document.getElementById('root');
if (rootEl === null) throw new Error('缺少 #root 挂载点');
createRoot(rootEl).render(<App />);
