/**
 * 构建配置 + 离线自证管线（架构定稿 §1/§2 Q3/附 6.3/附 6.6/附 6.7/附 6.8）。
 *
 * closeBundle 严格 7 步：
 *   1. 组装最终 HTML（读 dist/index.html，classic 脚本归一、赞助块处理）；
 *   2. 断言许可文本（整个 LICENSE_NOTICE 常量）不含 `-->` / `--!>` / `<!--`；
 *   3. 注入唯一许可注释块（LICENSE_NOTICE_BEGIN/END 标记，计数 === 1）；
 *   4. 只剥这一个块（非贪婪正则，匹配次数 === 1）；
 *   5. 剥离后断言 `<!--` 计数 = 0；
 *   6. 扫描禁用模式：每处 URL 要么在注释块内、要么等于页脚 <a href>
 *      （AFDIAN_URL 为 UNSET 时块外命中数 0）；其余禁用模式 0 命中；
 *   7. SHA-256 + 实际字节数 + 断言 dist/ 只有 1 个文件，输出 SHA256SUMS。
 *
 * `verify:offline` = `vite build --mode verify`，复用同一个 auditArtifact()，不另写脚本。
 *
 * 发布门禁 G4：REQUIRED_NOTICE_COPYRIGHT / REQUIRED_NOTICE_CONTACT / AFDIAN_URL 三项
 * 未填实（UNSET）时，普通 build 只打印警告；`--mode release` 直接 build 失败。
 *
 * 构建期回归断言（T02/T05，全部机器判定）：
 *   - runParserRegressionTests()：parseLine 永不 throw、脏数据计数、usage max-非-sum
 *     （2.7 倍案例）、escapeHtml、报告零外链审计、ReviewItem/SanitizedEvent 白名单、
 *     复盘包零泄漏断言（字段名 + 字面值出现次数均为 0）、intentShort ≤80 字、
 *     fieldMap 换样本零改内核、200 条截断、确定性；
 *   - assertPromptTemplate()：五类断言 + 正面契约（附 6.8 D2）；
 *   - assertWhitelistDivergence()：三条回归断言 + 反向用例（附 6.8 D3/D4）；
 *   - assertPrivacyParity()：页脚隐私声明与 README / 统一口径逐字一致（附 6.7 G2）。
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execSync } from 'node:child_process';
import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { viteSingleFile } from 'vite-plugin-singlefile';
import {
  buildReviewPackage,
  buildIndex,
  computeUsageTotal,
  createEmptyStats,
  dedupe,
  escapeHtml,
  finalizeEvents,
  maskText,
  mergeEvents,
  normalize,
  parseLine,
  parseTimestamp,
  renderReport,
  renderReviewText,
  REVIEW_DETAIL_LIMIT,
  sanitize,
  search,
  toReviewItem,
} from './src/core/parser';
import { applyOverrides, DEFAULT_FIELD_MAP } from './src/core/fieldMap';
import type {
  MaskOptions,
  NormalizedEvent,
  ParseStats,
  ReviewItem,
  ReviewPackage,
  SanitizedEvent,
} from './src/core/types';

const ROOT = typeof __dirname !== 'undefined' ? __dirname : process.cwd();
const DIST_DIR = path.join(ROOT, 'dist');
const OUTPUT_NAME = 'local_ai_session_timeline.html';

// ---------------------------------------------------------------------------
// 发布门禁字面值（附 6.7 G4）：UNSET 为哨兵；填值动作由用户本人完成
// ---------------------------------------------------------------------------

const REQUIRED_NOTICE_COPYRIGHT = 'Copyright (c) 2026 ZXYHIM';
const REQUIRED_NOTICE_CONTACT =
  'https://github.com/ZXYHIM/local_ai_session_timeline/issues/new?template=commercial-license.md';
const REPO_URL = 'https://github.com/ZXYHIM/local_ai_session_timeline';
const AFDIAN_URL = 'UNSET';

// ---------------------------------------------------------------------------
// 复盘提示词模板（唯一字面量来源；经 define 注入 __REVIEW_PROMPT__，永不回退进产物配置）
// ---------------------------------------------------------------------------

const REVIEW_PROMPT_TEMPLATE = [
  '以下是一次本地编码会话的结构化复盘材料，由本地工具以确定性算法统计生成，',
  '仅包含事件类型、时间、工具名、文件变更类型、用量计数与用户意图短句。',
  '请围绕上述字段回答：',
  '1. 各事件类型的计数分布与时间分布呈现出怎样的工作节奏？',
  '2. 高频工具名与文件变更类型反映了哪些操作习惯？是否存在可精简的重复模式？',
  '3. 用量计数随时间的走势如何？是否出现异常峰值？',
  '4. 结合各条用户意图短句，本次会话的目标是否清晰、是否达成？给出具体改进建议。',
  '（说明：本工具不调用任何模型；摘要与提示词由本地算法生成，请复制到你自己的账号执行。）',
].join('\n');

/** 仅构建期内存，永不进产物（附 6.2） */
const VENDOR_BLOCKLIST: readonly string[] = [
  'OpenAI',
  'Anthropic',
  'Claude',
  'ChatGPT',
  'GPT',
  'Gemini',
  'DeepSeek',
  'Kimi',
  'Moonshot',
  'Qwen',
  '通义',
  '文心',
  'Copilot',
  'Cursor',
  'Llama',
  'Mistral',
  'Grok',
  'xAI',
  '豆包',
  '智谱',
  'CodeGeeX',
  '混元',
];

/** 禁暗示存在对话全文的措辞（附 6.8 D2；仅构建期内存） */
const PROMPT_BANNED_PHRASES: readonly string[] = [
  '请总结以下对话',
  '请分析以下回复',
  '完整会话',
  '对话内容',
  '全文',
  '原文',
  'displayText',
  'cwd',
  'filePath',
  'toolArgs',
  'raw',
  'sessionId',
  'messageId',
  'requestId',
];

/** UI/文档禁词（架构定稿 §8；仅构建期内存） */
const PROMPT_BANNED_WORDS: readonly string[] = [
  'AI 生成',
  '已接入',
  '已连接',
  '已启用在线',
  '适用于',
  '兼容',
  '联网',
  '在线',
];

/** 正面契约：模板只可基于这五个维度 + 意图短句请求复盘（附 6.8 D2） */
const PROMPT_REQUIRED_DIMENSIONS: readonly string[] = [
  '事件类型',
  '时间',
  '工具名',
  '文件变更类型',
  '计数',
  '意图短句',
];

// ---------------------------------------------------------------------------
// 隐私统一措辞（附 5，逐字）
// ---------------------------------------------------------------------------

const PRIVACY_SENTENCE =
  '剪贴板是工具内唯一可被带到外部应用或账号的出口，且只承载脱敏后文本；报告下载仅为本机文件写入、内容仍在本设备，同样只承载脱敏后文本。';
const README_MODEL_SENTENCE =
  '本工具不调用任何模型：摘要与复盘提示词由本地确定性算法生成，如需 AI 参与复盘，请复制脱敏文本到你自己的模型账号执行。';

// ---------------------------------------------------------------------------
// 断言工具
// ---------------------------------------------------------------------------

function fail(message: string): never {
  throw new Error(`[build-assert] ${message}`);
}

function assert(cond: boolean, label: string): void {
  if (!cond) fail(label);
}

function assertEq(actual: unknown, expected: unknown, label: string): void {
  if (actual !== expected) {
    fail(`${label}：期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`);
  }
}

function countOccurrences(haystack: string, needle: string): number {
  if (needle === '') return 0;
  return haystack.split(needle).length - 1;
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// ---------------------------------------------------------------------------
// LICENSE_NOTICE（单一常量：Required Notice 行 + PolyForm 官方原文 + 6 个第三方 LICENSE 全文）
// ---------------------------------------------------------------------------

const THIRD_PARTY_LICENSES: ReadonlyArray<{ pkg: string; file: string }> = [
  { pkg: 'react', file: 'LICENSE' },
  { pkg: 'react-dom', file: 'LICENSE' },
  { pkg: 'typescript', file: 'LICENSE.txt' },
  { pkg: 'vite', file: 'LICENSE.md' },
  { pkg: '@vitejs/plugin-react', file: 'LICENSE' },
  { pkg: 'vite-plugin-singlefile', file: 'LICENSE' },
];

function loadPolyFormText(): string {
  const licensePath = path.join(ROOT, 'LICENSE');
  if (!fs.existsSync(licensePath)) fail('仓库根缺少 LICENSE 文件（PolyForm Noncommercial 1.0.0）');
  const license = fs.readFileSync(licensePath, 'utf8');
  const anchor = '# PolyForm Noncommercial License 1.0.0';
  const idx = license.indexOf(anchor);
  if (idx < 0) fail('LICENSE 文件中未找到 PolyForm Noncommercial 1.0.0 官方原文锚点（不得改字）');
  return license.slice(idx).trimEnd();
}

function loadThirdPartyLicenses(): string {
  return THIRD_PARTY_LICENSES.map(({ pkg, file }) => {
    const p = path.join(ROOT, 'node_modules', pkg, file);
    if (!fs.existsSync(p)) {
      fail(`未找到第三方 LICENSE：node_modules/${pkg}/${file}（请先 npm install）`);
    }
    return `----- 第三方组件 ${pkg} 许可全文 -----\n${fs.readFileSync(p, 'utf8').trimEnd()}`;
  }).join('\n\n');
}

function buildLicenseNotice(): string {
  const requiredNotices = [
    `Required Notice: ${REQUIRED_NOTICE_COPYRIGHT}`,
    `Required Notice: Commercial licensing contact: ${REQUIRED_NOTICE_CONTACT}`,
    `Required Notice: Source repository: ${REPO_URL}`,
  ].join('\n');
  return [
    'local_ai_session_timeline 单文件构建产物的许可与声明（本注释块为法律文本；浏览器从不加载 HTML 注释内容）。',
    requiredNotices,
    loadPolyFormText(),
    loadThirdPartyLicenses(),
  ].join('\n\n');
}

// ---------------------------------------------------------------------------
// 注入与剥离（injectNotice 与 auditArtifact 读同一份常量，不各自拼装）
// ---------------------------------------------------------------------------

const LICENSE_SLOT = '<!--LICENSE_NOTICE_SLOT-->';
const STRIP_LICENSE_BLOCK_SOURCE =
  '<!--\\s*LICENSE_NOTICE_BEGIN[\\s\\S]*?LICENSE_NOTICE_END\\s*-->';

function injectNotice(html: string, notice: string): string {
  const block = `<!-- LICENSE_NOTICE_BEGIN\n${notice}\nLICENSE_NOTICE_END -->`;
  let result: string;
  if (html.includes(LICENSE_SLOT)) {
    result = html.replace(LICENSE_SLOT, block);
  } else {
    // 兜底：若构建链剥掉了槽位注释，插到 doctype 之后
    result = html.replace(/<!DOCTYPE html>/i, (m) => `${m}\n${block}`);
  }
  const count = countLicenseBlocks(result);
  if (count !== 1) fail(`许可注释块数量必须为 1，实际 ${count}`);
  return result;
}

function countLicenseBlocks(html: string): number {
  const re = new RegExp(STRIP_LICENSE_BLOCK_SOURCE, 'g');
  return html.match(re)?.length ?? 0;
}

// ---------------------------------------------------------------------------
// 离线审计（与 verify:offline 同一把尺）
// ---------------------------------------------------------------------------

/** 禁用运行时能力模式：剥离许可注释块后必须 0 命中 */
const BANNED_RUNTIME_PATTERNS: ReadonlyArray<[string, RegExp]> = [
  ['fetch(', /fetch\s*\(/],
  ['XMLHttpRequest', /XMLHttpRequest/],
  ['WebSocket', /WebSocket/],
  ['EventSource', /EventSource/],
  ['sendBeacon', /sendBeacon/],
  ['importScripts', /importScripts/],
  ['@import', /@import/],
  ['CSS url()', /url\(/],
  ['<link>', /<link[\s>]/i],
  ['<script src>', /<script[^>]+src=/i],
  ['mailto:', /mailto:/i],
  ['navigator.share', /navigator\s*\.\s*share/],
  ['window.open', /window\s*\.\s*open\s*\(/],
  ['localStorage', /localStorage/],
  ['sessionStorage', /sessionStorage/],
  ['IndexedDB', /indexedDB/i],
  ['ServiceWorker', /serviceWorker/],
  ['document.cookie', /document\s*\.\s*cookie/],
  ['navigator.onLine', /navigator\s*\.\s*onLine/],
];

const URL_PATTERN = /https?:\/\/[^\s"'`<>\\)]+/g;

/**
 * 已知惰性 URL 前缀（不属于许可块、也不是页脚 <a href>，逐条打印说明）：
 * - W3C 命名空间标识符：DOM API（createElementNS/setAttributeNS）规范要求的确切字符串常量，
 *   不是可获取的网络资源，任何浏览器都不会对其发起请求，且改写会直接破坏 DOM API 语义；
 * - React 错误码说明文本：react/react-dom 生产构建内错误消息中的提示文字（惰性字符串，
 *   不会发起请求）。
 * 以上均为第三方运行库内部的规范标识符/提示文本，本工具不修改任何第三方代码字节。
 */
const KNOWN_INERT_URL_PREFIXES: ReadonlyArray<{ prefix: string; reason: string }> = [
  { prefix: 'http://www.w3.org/', reason: 'W3C DOM 规范命名空间标识符（非网络资源）' },
  { prefix: 'https://reactjs.org/docs/error-decoder.html', reason: 'React 错误码说明文本（惰性字符串）' },
  { prefix: 'https://react.dev/errors/', reason: 'React 错误码说明文本（惰性字符串）' },
];

export interface AuditResult {
  sha256: string;
  bytes: number;
  inBlockUrls: number;
  footerUrlHits: number;
  inertUrlHits: number;
}

function auditArtifact(html: string, label: string): AuditResult {
  // 步骤 4：只剥这一个块（非贪婪，计数 === 1）
  const blockCount = countLicenseBlocks(html);
  if (blockCount !== 1) fail(`[${label}] 许可注释块计数必须为 1，实际 ${blockCount}`);
  const blockMatch = new RegExp(STRIP_LICENSE_BLOCK_SOURCE).exec(html);
  const blockText = blockMatch?.[0] ?? '';
  const stripped = html.replace(new RegExp(STRIP_LICENSE_BLOCK_SOURCE), '');

  // 步骤 5：剥离后断言 <!-- 计数 = 0（--> / --!> 一并覆盖）
  assertEq(countOccurrences(stripped, '<!--'), 0, `[${label}] 剥离许可块后仍存在 <!--`);
  assertEq(countOccurrences(stripped, '-->'), 0, `[${label}] 剥离许可块后仍存在 -->`);
  assertEq(countOccurrences(stripped, '--!>'), 0, `[${label}] 剥离许可块后仍存在 --!>`);

  // 内联脚本必须为 classic（无外部 src）
  assert(
    !/<script[^>]+src=/i.test(stripped),
    `[${label}] 存在带 src 的 <script>（必须是内联普通脚本）`,
  );
  assert(!/<link[\s>]/i.test(stripped), `[${label}] 存在 <link> 引用`);
  assert(!stripped.includes('SPONSOR_SLOT'), `[${label}] 赞助槽位未被正确处理`);
  assert(!stripped.includes('type="module"'), `[${label}] 内联脚本不得保留 type="module"`);

  // 步骤 6a：禁用运行时能力模式 0 命中
  for (const [name, pattern] of BANNED_RUNTIME_PATTERNS) {
    assert(!pattern.test(stripped), `[${label}] 禁用模式命中：${name}`);
  }

  // 步骤 6b：URL 归属逐条分类——要么在许可注释块内，要么等于页脚 <a href>
  const inBlockUrls = blockText.match(URL_PATTERN)?.length ?? 0;
  const outUrls = stripped.match(URL_PATTERN) ?? [];
  const footerAllowed = AFDIAN_URL !== 'UNSET' ? [AFDIAN_URL] : [];
  const footerUrlHits = outUrls.filter((u) => footerAllowed.includes(u)).length;
  const inertHits = outUrls.filter(
    (u) => !footerAllowed.includes(u) && KNOWN_INERT_URL_PREFIXES.some((k) => u.startsWith(k.prefix)),
  );
  const otherUrls = outUrls.filter(
    (u) =>
      !footerAllowed.includes(u) && !KNOWN_INERT_URL_PREFIXES.some((k) => u.startsWith(k.prefix)),
  );
  if (otherUrls.length > 0) {
    fail(`[${label}] 存在未分类 URL（必须逐条可解释）：${otherUrls.join(' | ')}`);
  }
  if (footerUrlHits !== footerAllowed.length) {
    fail(
      `[${label}] 页脚 <a href> 命中数必须为 ${footerAllowed.length}（AFDIAN_URL ${
        AFDIAN_URL === 'UNSET' ? '未填（UNSET，预期 0）' : '已填（预期 1）'
      }），实际 ${footerUrlHits}`,
    );
  }
  if (inertHits.length > 0) {
    console.log(`[offline-audit:${label}] 已知惰性 URL ${inertHits.length} 处（逐条说明）：`);
    for (const u of inertHits) {
      const reason = KNOWN_INERT_URL_PREFIXES.find((k) => u.startsWith(k.prefix))?.reason ?? '';
      console.log(`  - ${u}  ← ${reason}`);
    }
  }
  const expectedFooter = AFDIAN_URL === 'UNSET' ? '0（UNSET）' : '1（页脚赞助链接）';
  console.log(
    `[offline-audit:${label}] 块内 URL 数 ${inBlockUrls} / 块外命中数 ${footerUrlHits}（${expectedFooter}）` +
      `${inertHits.length > 0 ? `，另有已知惰性 URL ${inertHits.length} 处（见上，均不可加载）` : ''}`,
  );

  const bytes = Buffer.byteLength(html, 'utf8');
  const sha256 = crypto.createHash('sha256').update(html, 'utf8').digest('hex');
  return { sha256, bytes, inBlockUrls, footerUrlHits, inertUrlHits: inertHits.length };
}

// ---------------------------------------------------------------------------
// 赞助块：AFDIAN_URL 为 UNSET 时整块不渲染（含「赞助不构成商用授权」文字）
// ---------------------------------------------------------------------------

function injectSponsorBlock(html: string): string {
  const slotPattern = /<p id="sponsor-block"[^>]*>[\s\S]*?<\/p>/;
  if (AFDIAN_URL === 'UNSET') {
    return html.replace(slotPattern, '');
  }
  const block =
    `<p id="sponsor-block" class="sponsor">觉得有用？<a href="${AFDIAN_URL}" target="_blank" ` +
    'rel="noopener noreferrer nofollow" referrerpolicy="no-referrer">爱发电 · 赞助支持</a>（赞助不构成商用授权）</p>';
  return html.replace(slotPattern, block);
}

// ---------------------------------------------------------------------------
// 构建期回归断言（T02 / 附 6.8）
// ---------------------------------------------------------------------------

function makeSyntheticLines(): string[] {
  const lines: string[] = [];
  // 1. 用户消息：含 API Key 与本地路径（脱敏断言素材）
  lines.push(
    JSON.stringify({
      type: 'user',
      session_id: 'SESSID-SYNTH-LEAK-42',
      cwd: '/Users/synthuser/synth-cwd',
      message: {
        role: 'user',
        content: '帮我看下 /Users/synthuser/synth-project/src/leak.ts，密钥是 sk-SYNTHKEY000000LEAK',
      },
      message_id: 'MSGID-SYNTH-LEAK-7',
      timestamp: '2026-11-18T10:00:00Z',
    }),
  );
  // 2-19. 流式重复行：同一 message_id 重复 18 次（usage input=100/output=20，内容递增→包含关系）
  for (let i = 0; i < 18; i += 1) {
    lines.push(
      JSON.stringify({
        type: 'assistant',
        message: { role: 'assistant', content: '分'.repeat(i + 1) },
        message_id: 'MSGID-SYNTH-STREAM-DUP',
        usage: { input_tokens: 100, output_tokens: 20 },
        timestamp: '2026-11-18T10:00:01Z',
      }),
    );
  }
  // 20. 助手消息：usage input=900/output=80（合并后 input 合计 = 1000，朴素求和 = 2700，恰 2.7 倍）
  lines.push(
    JSON.stringify({
      type: 'assistant',
      message: {
        role: 'assistant',
        content: '方案已更新，附 <script>alert("synth-xss")</script> 演示转义',
      },
      message_id: 'MSGID-SYNTH-ASSIST-2',
      usage: { input_tokens: 900, output_tokens: 80 },
      timestamp: '2026-11-18T10:00:02Z',
    }),
  );
  // 21. 工具调用（tool + name/arguments）
  lines.push(
    JSON.stringify({
      type: 'tool_call',
      tool: {
        name: 'SynthEdit',
        arguments: { file_path: '/Users/synthuser/synth-project/src/leak.ts', patch: 'SYNTH-PATCH-SENTINEL' },
      },
      tool_use_id: 'TOOLUSE-SYNTH-1',
      timestamp: '2026-11-18T10:00:03Z',
    }),
  );
  // 22. 文件变更（file_path + change_type）
  lines.push(
    JSON.stringify({
      type: 'file_change',
      file_path: '/Users/synthuser/synth-project/src/leak.ts',
      change_type: 'modified',
      diff: 'SYNTH-DIFF-SENTINEL',
      timestamp: '2026-11-18T10:00:04Z',
    }),
  );
  // 23. 非 JSON 行
  lines.push('this line is not json at all {{{');
  // 24. 空白行
  lines.push('   ');
  // 25. JSON 但非对象
  lines.push('[1, 2, 3]');
  // 26. 未知类型（嵌套字段）
  lines.push(
    JSON.stringify({ type: 'synth_unknown_kind', payload: { nested: { deep: 'SYNTH-UNKNOWN-RAW-TEXT' } } }),
  );
  // 27. 长用户消息（intentShort 截断断言：200 字 → 80 字）
  lines.push(
    JSON.stringify({
      type: 'user',
      message: { role: 'user', content: '甲'.repeat(200) },
      message_id: 'MSGID-SYNTH-USER-LONG',
      timestamp: '2026-11-18T10:00:05Z',
    }),
  );
  // 28. 含代码块的用户消息（intentShort 代码脱敏断言）
  lines.push(
    JSON.stringify({
      type: 'user',
      message: { role: 'user', content: '看下这段\n```\nSYNTH-CODE-BLOCK-SENTINEL\n```\n哪里有问题' },
      message_id: 'MSGID-SYNTH-USER-CODE',
      timestamp: '2026-11-18T10:00:06Z',
    }),
  );
  // 29-30. sessionId+requestId 组合键重复（usage 取 max 断言）
  lines.push(
    JSON.stringify({
      type: 'tool_call',
      session_id: 'SESSID-SYNTH-LEAK-42',
      request_id: 'REQID-SYNTH-LEAK-99',
      tool: { name: 'SynthRead', arguments: { file_path: '/Users/synthuser/synth-project/a.ts' } },
      usage: { input_tokens: 0, output_tokens: 20 },
      timestamp: '2026-11-18T10:00:07Z',
    }),
  );
  lines.push(
    JSON.stringify({
      type: 'tool_call',
      session_id: 'SESSID-SYNTH-LEAK-42',
      request_id: 'REQID-SYNTH-LEAK-99',
      tool: { name: 'SynthRead', arguments: { file_path: '/Users/synthuser/synth-project/a.ts' } },
      usage: { input_tokens: 0, output_tokens: 30 },
      timestamp: '2026-11-18T10:00:07Z',
    }),
  );
  return lines;
}

function runParserRegressionTests(): void {
  const fieldMap = DEFAULT_FIELD_MAP;
  const maskAll: MaskOptions = { stripPaths: true, stripApiKeys: true, stripCode: true };

  // ---- parseLine 永不 throw + 脏数据计数 ----
  const weirdLines = ['', '   ', '{', 'null', '123', '"str"', '[1]', ']]]', '\uFEFF{"a":1}'];
  for (const [i, line] of weirdLines.entries()) {
    let raw;
    try {
      raw = parseLine(line, i + 1);
    } catch (err) {
      fail(`parseLine 对脏数据必须永不 throw（第 ${i + 1} 行抛出：${messageOf(err)}）`);
    }
    if (line.trim() === '') assertEq(raw.status, 'skipped_empty', `空行状态（${JSON.stringify(line)}）`);
  }
  assertEq(parseLine('null', 1).status, 'skipped_json', 'JSON 非对象应计 skipped_json');
  assertEq(parseLine('[1]', 1).status, 'skipped_json', 'JSON 数组应计 skipped_json');
  assertEq(parseLine('not json', 1).status, 'skipped_non_json', '非 JSON 应计 skipped_non_json');
  assertEq(parseLine('{"a":1}', 1).status, 'ok', '正常 JSON 行状态');

  // ---- 时间戳归一 ----
  assertEq(parseTimestamp(1780000000000), 1780000000000, '毫秒时间戳应原样保留');
  assertEq(parseTimestamp(1780000000), 1780000000000, '秒级时间戳应乘 1000');
  assertEq(parseTimestamp('2026-11-18T10:00:00Z'), Date.parse('2026-11-18T10:00:00Z'), 'ISO 字符串解析');
  assertEq(parseTimestamp('garbage'), null, '非法时间字符串应为 null');
  assertEq(parseTimestamp(null), null, 'null 时间应为 null');

  // ---- escapeHtml ----
  assertEq(escapeHtml('<>"\'&'), '&lt;&gt;&quot;&#39;&amp;', 'escapeHtml 基本转义');
  assertEq(escapeHtml('<script>alert("x")</script>'), '&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;', 'escapeHtml 脚本转义');

  // ---- 全量合成样例 → normalize → dedupe → usageTotal（数据口径唯一） ----
  const lines = makeSyntheticLines();
  const stats: ParseStats = createEmptyStats();
  const rawEvents: NormalizedEvent[] = [];
  for (const [i, line] of lines.entries()) {
    const raw = parseLine(line, i + 1);
    stats.totalLines += 1;
    if (raw.status !== 'ok') {
      stats.skippedLines += 1;
      stats.skippedByReason[raw.status] = (stats.skippedByReason[raw.status] ?? 0) + 1;
      continue;
    }
    stats.okLines += 1;
    const ev = normalize(raw, fieldMap);
    stats.byKind[ev.kind] += 1;
    if (ev.kind === 'unknown') stats.unknownCount += 1;
    rawEvents.push(ev);
  }
  assertEq(stats.totalLines, 30, '合成样例总行数');
  assertEq(stats.skippedLines, 3, '跳过行数（非 JSON / 空行 / 非对象各 1）');
  assertEq(stats.okLines, 27, '成功行数');
  assertEq(stats.byKind.user_message, 3, 'user_message 计数（去重前）');
  assertEq(stats.byKind.assistant_message, 19, 'assistant_message 计数（去重前）');
  assertEq(stats.byKind.tool_call, 3, 'tool_call 计数（去重前）');
  assertEq(stats.byKind.file_change, 1, 'file_change 计数');
  assertEq(stats.unknownCount, 1, 'unknown 计数');

  const { events, mergedDuplicates } = finalizeEvents(rawEvents);
  assertEq(mergedDuplicates, 18, '流式重复合并数（17 + 1）');
  assertEq(events.length, 9, '去重后事件数');
  stats.mergedDuplicates = mergedDuplicates;
  stats.usageTotal = computeUsageTotal(events);

  // 2.7 倍回归断言：18 条重复（各 input=100）+ 1 条 input=900 → 正确值 1000，朴素求和 2700
  assertEq(stats.usageTotal.inputTokens, 1000, 'usageTotal.inputTokens 必须是去重后合计（1000）');
  assert(stats.usageTotal.inputTokens !== 2700, 'usageTotal.inputTokens 绝不能是朴素求和值 2700（2.7 倍虚高案例）');
  assertEq(stats.usageTotal.outputTokens, 130, 'usageTotal.outputTokens（20+80+30）');
  assertEq(stats.usageTotal.totalTokens, 1130, 'usageTotal.totalTokens（120+980+30）');

  // 排序与 seq：时间升序，无时间戳（Infinity）按首行号兜底排最后
  assertEq(events[0].kind, 'user_message', 'seq1 应为首条用户消息');
  assertEq(events[1].sourceLineNos.length, 18, '流式重复行 sourceLineNos 应为并集');
  assertEq(events[1].displayText, '分'.repeat(18), '合并 displayText 应取包含关系中更长者');
  assertEq(events[8].kind, 'unknown', '无时间戳的 unknown 事件应按行号兜底排在最后');
  assertEq(events[8].displayText.includes('SYNTH-UNKNOWN-RAW-TEXT'), true, 'unknown 原文应在内存模型中保留');
  assertEq(events[3].toolName, 'SynthEdit', 'tool_call 的 toolName');
  assertEq(events[4].fileChangeKind, 'modified', 'file_change 的 fileChangeKind');
  assertEq(events[7].usage.outputTokens, 30, '组合键重复行 usage 应逐字段取 max');
  assertEq(events[0].displayText.includes('***'), true, 'API Key 在内存 displayText 中也应掩码');

  // ---- 换样本只改 fieldMap：applyOverrides 覆盖 content 候选，parser.ts 零改动 ----
  const customMap = applyOverrides(DEFAULT_FIELD_MAP, { content: ['synthContent'] });
  const customRaw = parseLine(JSON.stringify({ role: 'user', synthContent: '自定义字段内容' }), 1);
  const customEv = normalize(customRaw, customMap);
  assertEq(customEv.kind, 'user_message', '自定义映射下的分类');
  assertEq(customEv.displayText, '自定义字段内容', '自定义映射下的内容提取');

  // ---- 搜索 ----
  const index = buildIndex(events);
  assertEq(JSON.stringify(search(index, 'SYNTH-UNKNOWN', 500)), '[9]', '搜索应命中 unknown 事件');
  assertEq(search(index, '', 500).length, 0, '空查询应返回空');
  assertEq(search(index, '分', 1).length, 1, 'limit 应生效');

  // ---- SanitizedEvent 白名单（导出报告出口） ----
  const sanitizedAll: SanitizedEvent[] = events.map((ev) => sanitize(ev, maskAll));
  for (const s of sanitizedAll) {
    const keys = Object.keys(s).sort();
    assertEq(
      JSON.stringify(keys),
      JSON.stringify(['displayText', 'kind', 'seq', 'timestamp', 'usage']),
      'SanitizedEvent 键集合必须严格为 5 字段（含 displayText）',
    );
  }
  const sanitizedUser = sanitizedAll[0];
  assertEq(sanitizedUser.displayText.includes('sk-SYNTHKEY000000LEAK'), false, '导出文本不得含 API Key 字面值');
  assertEq(sanitizedUser.displayText.includes('***'), true, 'API Key 应被掩码为 ***');
  assertEq(sanitizedUser.displayText.includes('/Users/synthuser'), false, '导出文本不得含本地路径字面值');
  assertEq(sanitizedUser.displayText.includes('<path>'), true, '本地路径应脱敏为 <path>');

  // ---- 导出报告：escapeHtml 断言 + 零外链审计 + 无 NC 声明 ----
  const report = renderReport(sanitizedAll, stats, maskAll);
  assertEq(report.includes('&lt;script&gt;'), true, '报告中 <script> 必须被转义');
  assertEq(report.includes('<script>alert'), false, '报告中不得出现未转义脚本标签');
  assertEq(/https?:\/\//.test(report), false, '导出报告必须零 URL');
  assertEq(report.includes('mailto:'), false, '导出报告不得含 mailto');
  assertEq(report.includes("connect-src 'none'"), true, '导出报告必须自带 connect-src none');
  assertEq(report.includes('PolyForm'), false, '导出报告不得含 NC 声明');
  assertEq(report.includes('Noncommercial'), false, '导出报告不得含 NC 声明（2）');
  for (const [name, pattern] of BANNED_RUNTIME_PATTERNS) {
    assert(!pattern.test(report), `导出报告命中禁用模式：${name}`);
  }

  // ---- ReviewItem / ReviewPackage（复盘包出口，独立白名单） ----
  const wanted = new Set(events.map((ev) => ev.seq));
  const pkg = buildReviewPackage(events, stats, { seqs: wanted });
  const items = events.map((ev) => toReviewItem(ev));
  const reviewText = renderReviewText(pkg);

  // D3①：ReviewItem 键集合 ⊆ 7 项且不含 displayText
  const allowedKeys = ['seq', 'timestamp', 'kind', 'toolName', 'fileChangeKind', 'usage', 'intentShort'];
  for (const item of items) {
    for (const key of Object.keys(item)) {
      assert(allowedKeys.includes(key), `ReviewItem 出现越界键：${key}`);
    }
    assert(!('displayText' in item), 'ReviewItem 绝不含 displayText');
  }
  // intentShort 仅来自 user_message 且逐字保留（掩码 + 截断）
  for (const item of items) {
    if (item.kind !== 'user_message') {
      assert(!('intentShort' in item), `非 user_message 不得产出 intentShort（${item.kind}）`);
    } else {
      assert(item.intentShort !== undefined, 'user_message 必须产出 intentShort');
      assert(item.intentShort.length <= 80, 'intentShort 必须 ≤80 字');
    }
  }
  assertEq(items[5].intentShort, '甲'.repeat(80), 'intentShort 应逐字保留前 80 字');
  assertEq(reviewText.includes('甲'.repeat(81)), false, '复盘文本不得出现第 81 字');
  assertEq(reviewText.includes('[code omitted]'), true, 'intentShort 中代码块应被脱敏');

  // D4：字段名 + 字面值出现次数均为 0（逐条独立断言）
  const zeroCountChecks: Array<[string, string]> = [
    ['API Key 字面值', 'sk-SYNTHKEY000000LEAK'],
    ['本地路径字面值', '/Users/synthuser'],
    ['sessionId 字面值', 'SESSID-SYNTH-LEAK-42'],
    ['messageId 字面值', 'MSGID-SYNTH-LEAK-7'],
    ['requestId 字面值', 'REQID-SYNTH-LEAK-99'],
    ['cwd 字面值', '/Users/synthuser/synth-cwd'],
    ['代码块字面值', 'SYNTH-CODE-BLOCK-SENTINEL'],
    ['toolArgs 字面值', 'SYNTH-PATCH-SENTINEL'],
    ['diff 字面值', 'SYNTH-DIFF-SENTINEL'],
    ['unknown 原文字面值', 'SYNTH-UNKNOWN-RAW-TEXT'],
    ['脚本标签字面值', '<script>'],
    ['raw 字段名', 'raw'],
    ['displayText 字段名', 'displayText'],
    ['cwd 字段名', 'cwd'],
    ['filePath 字段名', 'filePath'],
    ['toolArgs 字段名', 'toolArgs'],
    ['sessionId 字段名', 'sessionId'],
    ['messageId 字段名', 'messageId'],
    ['requestId 字段名', 'requestId'],
  ];
  for (const [label, literal] of zeroCountChecks) {
    assertEq(countOccurrences(reviewText, literal), 0, `复盘包文本中${label}出现次数必须为 0`);
  }
  assertEq(/https?:\/\//.test(reviewText), false, '复盘包文本必须零 URL');
  assertEq(reviewText.includes('mailto:'), false, '复盘包文本不得含 mailto');
  assertEq(reviewText.includes('PolyForm'), false, '复盘包文本不得含 NC 声明');
  assertEq(reviewText.includes('Noncommercial'), false, '复盘包文本不得含 NC 声明（2）');
  for (const vendor of VENDOR_BLOCKLIST) {
    assertEq(reviewText.includes(vendor), false, `复盘包文本不得含厂商名：${vendor}`);
  }
  assertEq(reviewText.includes('工具=SynthEdit'), true, '复盘包应含工具名维度');
  assertEq(reviewText.includes('变更=modified'), true, '复盘包应含文件变更类型维度');
  assertEq(reviewText.includes('输入 1000 / 输出 130 / 总计 1130'), true, '复盘包应含用量计数维度');
  assertEq(pkg.prompt, REVIEW_PROMPT_TEMPLATE, '复盘包提示词必须是构建期注入的静态模板');
  assertEq(pkg.includedSeqs.length, 9, 'includedSeqs 数');
  assertEq(pkg.truncated, false, '未超上限时不应截断');

  // D3③：两条出口不共用序列化函数（含反向用例）
  assert(
    (() => {
      try {
        renderReviewText(sanitizedAll as unknown as ReviewPackage);
        return false;
      } catch (err) {
        return err instanceof TypeError;
      }
    })(),
    'renderReviewText 传入 SanitizedEvent[] 必须抛 TypeError（反向用例：合并两条白名单应失败）',
  );
  assert(
    (() => {
      try {
        renderReport(items as unknown as SanitizedEvent[], stats, maskAll);
        return false;
      } catch (err) {
        return err instanceof TypeError;
      }
    })(),
    'renderReport 传入 ReviewItem[] 必须抛 TypeError（反向用例：合并两条白名单应失败）',
  );

  // 确定性：同输入同输出
  const pkg2 = buildReviewPackage(events, stats, { seqs: new Set(events.map((ev) => ev.seq)) });
  assertEq(JSON.stringify(pkg2), JSON.stringify(pkg), 'buildReviewPackage 必须是纯确定性函数');

  // 明细上限 200 条截断
  const filler: NormalizedEvent[] = [];
  for (let i = 0; i < 205; i += 1) {
    filler.push({
      seq: 0,
      kind: 'user_message',
      timestamp: null,
      displayText: `补条目 ${i + 1}`,
      usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
      dedupeKey: `FILLER-${i}`,
      sourceLineNos: [i + 1],
    });
  }
  const finalizedFiller = finalizeEvents(filler);
  const bigStats: ParseStats = createEmptyStats();
  bigStats.totalLines = 205;
  bigStats.okLines = 205;
  const bigPkg = buildReviewPackage(finalizedFiller.events, bigStats, {
    seqs: new Set(finalizedFiller.events.map((ev) => ev.seq)),
  });
  assertEq(bigPkg.includedSeqs.length, REVIEW_DETAIL_LIMIT, `明细上限必须为 ${REVIEW_DETAIL_LIMIT} 条`);
  assertEq(bigPkg.truncated, true, '超出上限必须标记截断');
  assertEq(renderReviewText(bigPkg).includes('已截断'), true, '截断必须在文本中明示');

  // mergeEvents 直接单测：displayText 拼接（非包含关系）
  const a: NormalizedEvent = {
    seq: 1, kind: 'user_message', timestamp: 100, displayText: 'abc',
    usage: { inputTokens: 5, outputTokens: 0, totalTokens: 5 }, dedupeKey: 'k', sourceLineNos: [1],
  };
  const b: NormalizedEvent = {
    seq: 2, kind: 'user_message', timestamp: 90, displayText: 'xyz',
    usage: { inputTokens: 3, outputTokens: 4, totalTokens: 7 }, dedupeKey: 'k', sourceLineNos: [2],
  };
  const merged = mergeEvents(a, b);
  assertEq(merged.displayText, 'abc\nxyz', '非包含关系 displayText 应按行序拼接');
  assertEq(merged.timestamp, 90, 'timestamp 应取最早非空');
  assertEq(merged.usage.inputTokens, 5, 'usage 合并应取 max');
  assertEq(merged.usage.outputTokens, 4, 'usage 合并应取 max（2）');
  assertEq(dedupe([a, b]).mergedDuplicates, 1, 'dedupe 计数');
}

// ---------------------------------------------------------------------------
// 提示词模板五类断言 + 正面契约（附 6.8 D2）
// ---------------------------------------------------------------------------

function assertPromptTemplate(): void {
  const t = REVIEW_PROMPT_TEMPLATE;
  // 1) 厂商名
  for (const vendor of VENDOR_BLOCKLIST) {
    assertEq(t.includes(vendor), false, `提示词模板不得含厂商名：${vendor}`);
  }
  // 2) URL / mailto
  assertEq(/https?:\/\//.test(t), false, '提示词模板不得含 URL');
  assertEq(t.includes('mailto:'), false, '提示词模板不得含 mailto');
  // 3) Key 占位符
  for (const k of ['sk-', 'api_key', 'apiKey', 'API_KEY', 'Bearer ']) {
    assertEq(t.includes(k), false, `提示词模板不得含 Key 占位符：${k}`);
  }
  // 4) 禁词
  for (const w of PROMPT_BANNED_WORDS) {
    assertEq(t.includes(w), false, `提示词模板禁词：${w}`);
  }
  // 5) 禁暗示存在对话全文的措辞 + 白名单字段名
  for (const p of PROMPT_BANNED_PHRASES) {
    assertEq(t.includes(p), false, `提示词模板禁暗示措辞：${p}`);
  }
  // 正面契约：只可基于五个维度 + 意图短句请求复盘
  for (const dim of PROMPT_REQUIRED_DIMENSIONS) {
    assertEq(t.includes(dim), true, `提示词模板缺少必要维度：${dim}`);
  }
}

// ---------------------------------------------------------------------------
// 两条出口白名单背离断言（附 6.8 D3；与 runParserRegressionTests 内联跑，此处做结构级复核）
// ---------------------------------------------------------------------------

function assertWhitelistDivergence(): void {
  // ① 与 ② 已在 runParserRegressionTests 对实例对象断言；此处断言类型契约不共用序列化入口
  assertEq(typeof renderReviewText, 'function', 'renderReviewText 必须存在');
  assertEq(typeof renderReport, 'function', 'renderReport 必须存在');
  assertEq(renderReviewText.length, 1, 'renderReviewText 只接受一个 ReviewPackage 参数');
  assertEq(renderReport.length, 3, 'renderReport 只接受 (SanitizedEvent[], stats, mask)');
}

// ---------------------------------------------------------------------------
// G3 门禁（真实形态 Key / 路径扫描；合成哨兵以 SYNTH / synth 标记排除）
// 口径（2026-11-18 裁定）：三条真实形态正则 + /Users/[a-z]+/；命中且不含合成标记才失败。
// 掩码正则定义行天然不命中（sk- 后没有 20+ 字符密钥、api[_-]?key 后是 "|" 非 value）。
// ---------------------------------------------------------------------------

const G3_KEY_PATTERNS: ReadonlyArray<[string, RegExp]> = [
  ['sk-Key', /sk-[A-Za-z0-9_-]{20,}/g],
  ['apiKey', /api[_-]?key["'\s:=]+[A-Za-z0-9]{16,}/gi],
  ['Bearer', /Bearer\s+[A-Za-z0-9._-]{20,}/g],
];
const G3_PATH_PATTERN = /\/Users\/[a-z]+\//g;

function listTrackedTextFiles(): string[] {
  try {
    const out = execSync('git ls-files', { cwd: ROOT, encoding: 'utf8' });
    return out
      .split('\n')
      .map((s) => s.trim())
      .filter((s) => s !== '');
  } catch {
    // git 不可用时退化为目录扫描（跳过 node_modules / dist / .git）
    const skip = new Set(['node_modules', 'dist', '.git']);
    const files: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (skip.has(entry.name)) continue;
        const p = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(p);
        else files.push(path.relative(ROOT, p));
      }
    };
    walk(ROOT);
    return files;
  }
}

function runG3Gate(): void {
  const files = listTrackedTextFiles();
  let synthHits = 0;
  const violations: string[] = [];
  for (const rel of files) {
    let content: string;
    try {
      content = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    } catch {
      continue;
    }
    if (content.includes('\u0000')) continue; // 跳过二进制文件
    for (const [name, pattern] of G3_KEY_PATTERNS) {
      for (const m of content.match(pattern) ?? []) {
        if (m.includes('SYNTH')) {
          synthHits += 1;
          continue;
        }
        violations.push(`${rel}: [${name}] ${m.slice(0, 60)}`);
      }
    }
    for (const m of content.match(G3_PATH_PATTERN) ?? []) {
      if (m.toLowerCase().includes('synth')) {
        synthHits += 1;
        continue;
      }
      violations.push(`${rel}: [path] ${m}`);
    }
  }
  if (violations.length > 0) {
    fail(`G3 门禁：发现真实形态 Key / 路径（需人工确认后处理）：\n${violations.join('\n')}`);
  }
  console.log(`[g3] G3 通过：真实形态 Key/路径命中 0（合成哨兵 ${synthHits} 处已排除）`);
}

// ---------------------------------------------------------------------------
// 隐私声明一致性（附 6.7 G2 + 2026-11-18 裁定 2：README 含句为硬断言，防漂移）
// ---------------------------------------------------------------------------

function assertPrivacyParity(artifact: string): void {
  const readmePath = path.join(ROOT, 'README.md');
  if (!fs.existsSync(readmePath)) fail('仓库根缺少 README.md（G2 门禁）');
  const readme = fs.readFileSync(readmePath, 'utf8');
  assertEq(artifact.includes(PRIVACY_SENTENCE), true, '产物页脚必须逐字包含附 5 隐私统一措辞');
  assertEq(artifact.includes(README_MODEL_SENTENCE), true, '产物页脚必须逐字包含 README 的不调用模型声明');
  // 防漂移门禁：README 必须包含该句原样子串（markdown 强调符 ** 除外；页脚为纯文本副本）
  const readmePlain = readme.replace(/\*\*/g, '');
  assertEq(
    readmePlain.includes(PRIVACY_SENTENCE),
    true,
    'README 必须包含附 5 隐私句（缺失即 build 失败，防止措辞漂移）',
  );
}

// ---------------------------------------------------------------------------
// 插件
// ---------------------------------------------------------------------------

/** dev 模式临时移除 CSP meta（HMR 需要网络）；构建产物不受影响 */
function devCspRelaxPlugin(): Plugin {
  return {
    name: 'dev-csp-relax',
    apply: 'serve',
    transformIndexHtml(html) {
      console.warn('[dev] 已临时移除 CSP meta 以便 vite dev / HMR 工作；构建产物不受影响。');
      return html.replace(/<meta http-equiv="Content-Security-Policy"[^>]*>\s*/, '');
    },
  };
}

function offlineAuditPlugin(mode: string): Plugin {
  return {
    name: 'local-ai-session-timeline-offline-audit',
    enforce: 'post',
    closeBundle() {
      const rawPath = path.join(DIST_DIR, 'index.html');
      if (!fs.existsSync(rawPath)) fail('构建产物缺少 dist/index.html');
      let html = fs.readFileSync(rawPath, 'utf8');

      // classic 脚本归一：iife 产物无 import/export，可安全作为普通脚本执行（file:// 最大兼容）；
      // singlefile 内联后可能残留 type="module" / crossorigin / async 属性，逐一剥掉
      html = html.replace(/<script([^>]*?)\s+type="module"([^>]*)>/g, (_m, a: string, b: string) => `<script${a}${b}>`);
      html = html.replace(/<script([^>]*?)\s+crossorigin([^>]*)>/g, (_m, a: string, b: string) => `<script${a}${b}>`);
      html = html.replace(/<script([^>]*?)\s+async([^>]*)>/g, (_m, a: string, b: string) => `<script${a}${b}>`);
      html = html.replace(/<script>\s*<\/script>/g, '');
      // 赞助块：UNSET 时整块不渲染
      html = injectSponsorBlock(html);

      // 步骤 2：断言许可文本安全（覆盖整个 LICENSE_NOTICE 常量）
      const notice = buildLicenseNotice();
      assertEq(notice.includes('-->'), false, 'LICENSE_NOTICE 不得含 -->（会提前闭合注释块）');
      assertEq(notice.includes('--!>'), false, 'LICENSE_NOTICE 不得含 --!>');
      assertEq(notice.includes('<!--'), false, 'LICENSE_NOTICE 不得含 <!--');
      // 步骤 3：注入唯一注释块
      html = injectNotice(html, notice);

      // 隐私声明一致性（G2）
      assertPrivacyParity(html);

      // release 门禁（G4）：产物不得出现占位形态
      if (mode === 'release') {
        for (const bad of ['UNSET', '<GITHUB_ID>', 'owner/repo', 'example.com']) {
          assertEq(html.includes(bad), false, `release 产物不得含占位形态：${bad}`);
        }
      }

      // 步骤 4-6：审计（与 verify:offline 同一把尺）
      const result = auditArtifact(html, mode);

      // 步骤 7：写出唯一 HTML + dist 只允许 1 个文件 + SHA-256
      const outPath = path.join(DIST_DIR, OUTPUT_NAME);
      fs.writeFileSync(outPath, html);
      fs.rmSync(rawPath);
      const files = fs.readdirSync(DIST_DIR);
      if (files.length !== 1) {
        fail(`dist/ 必须只有 1 个文件，实际 ${files.length} 个：${files.join(', ')}`);
      }
      fs.writeFileSync(path.join(ROOT, 'SHA256SUMS'), `${result.sha256}  dist/${OUTPUT_NAME}\n`);
      console.log(`[build:${mode}] 产物 dist/${OUTPUT_NAME}`);
      console.log(`[build:${mode}] SHA-256: ${result.sha256}`);
      console.log(`[build:${mode}] 字节数: ${result.bytes}（${(result.bytes / 1024).toFixed(1)} KB）`);
      console.log(`[build:${mode}] 已输出仓库根 SHA256SUMS`);
    },
  };
}

function parserRegressionPlugin(): Plugin {
  return {
    name: 'parser-regression-tests',
    buildStart() {
      // 构建期把模板经 globalThis 提供给内核（运行时由 vite define 注入 __REVIEW_PROMPT__）
      (globalThis as { __REVIEW_PROMPT__?: string }).__REVIEW_PROMPT__ = REVIEW_PROMPT_TEMPLATE;
      runParserRegressionTests();
      assertPromptTemplate();
      assertWhitelistDivergence();
      runG3Gate();
      console.log('[regression] T02/T05 全部构建期断言通过（usage max 非 sum / 白名单背离 / escapeHtml / 复盘包零泄漏 / 截断 / 确定性）。');
    },
  };
}

// ---------------------------------------------------------------------------
// 配置
// ---------------------------------------------------------------------------

export default defineConfig(({ mode }) => {
  // 发布门禁 G4：三项字面值未填实时，release 直接失败；普通 build 只警告
  if (mode === 'release') {
    if (AFDIAN_URL === 'UNSET') {
      fail('release 门禁（G4）：AFDIAN_URL 仍为 UNSET（爱发电真实 URL 未填），release 构建中止。');
    }
    if (REQUIRED_NOTICE_COPYRIGHT.includes('UNSET') || REQUIRED_NOTICE_CONTACT.includes('UNSET')) {
      fail('release 门禁（G4）：Required Notice 字面值仍为 UNSET，release 构建中止。');
    }
  } else if (AFDIAN_URL === 'UNSET') {
    console.warn(
      '[warn] AFDIAN_URL 仍为 UNSET：页脚赞助链接整块未渲染（含「赞助不构成商用授权」文字块）；' +
        'npm run build --mode release 将因此失败（发布门禁 G4）。',
    );
  }

  return {
    base: './',
    plugins: [
      react(),
      viteSingleFile({ useRecommendedBuildConfig: true }),
      devCspRelaxPlugin(),
      parserRegressionPlugin(),
      offlineAuditPlugin(mode),
    ],
    define: {
      __REVIEW_PROMPT__: JSON.stringify(REVIEW_PROMPT_TEMPLATE),
    },
    build: {
      target: 'es2020',
      sourcemap: false,
      cssCodeSplit: false,
      assetsInlineLimit: 100000000,
      outDir: 'dist',
      rollupOptions: {
        output: {
          format: 'iife',
          inlineDynamicImports: true,
        },
      },
    },
    worker: {
      format: 'iife',
    },
  };
});
