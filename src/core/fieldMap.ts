/**
 * 字段映射表（纯数据 + applyOverrides）——「换真实样本唯一要改的文件」。
 *
 * 约定（见架构定稿 §2 Q7 / §8）：
 * - 本文件是全部字段名常量的唯一聚集地；解析内核 parser.ts 不出现任何字段名常量；
 * - 候选路径按优先级排列，支持 `a.b[0].c` 形式的点路径与数组下标；
 * - 分类规则有序，先命中先定；内容零厂商名。
 */

import type { FieldMap } from './types';

export const DEFAULT_FIELD_MAP: FieldMap = {
  timestamp: [
    'timestamp',
    'ts',
    'time',
    'created_at',
    'createdAt',
    'message.created_at',
    'message.create_time',
    'event_time',
    'datetime',
  ],
  role: ['role', 'message.role', 'sender', 'author'],
  content: [
    'content',
    'text',
    'message.content',
    'message.text',
    'delta.text',
    'content[0].text',
    'message.content[0].text',
    'body',
  ],
  toolName: [
    'tool.name',
    'tool_calls[0].function.name',
    'function.name',
    'tool_use.name',
    'tool_name',
    'toolName',
    'name',
  ],
  toolArgs: [
    'tool.arguments',
    'tool_calls[0].function.arguments',
    'function.arguments',
    'arguments',
    'tool_input',
    'input',
    'parameters',
  ],
  filePath: [
    'file_path',
    'filePath',
    'path',
    'file',
    'filename',
    'tool.arguments.file_path',
    'input.file_path',
  ],
  sessionId: ['session_id', 'sessionId', 'conversation_id', 'conversationId'],
  messageId: [
    'message.id',
    'message_id',
    'messageId',
    'uuid',
    'tool_use_id',
    'tool_calls[0].id',
  ],
  requestId: ['request_id', 'requestId', 'parent_tool_use_id', 'parentToolUseId'],
  usageInput: [
    'usage.input_tokens',
    'usage.inputTokens',
    'usage.prompt_tokens',
    'usage.promptTokens',
    'input_tokens',
    'inputTokens',
    'tokens.input',
  ],
  usageOutput: [
    'usage.output_tokens',
    'usage.outputTokens',
    'usage.completion_tokens',
    'usage.completionTokens',
    'output_tokens',
    'outputTokens',
    'tokens.output',
  ],
  cwd: ['cwd', 'working_directory', 'workingDirectory', 'workdir'],
  fileChangeKind: ['change_type', 'changeType', 'change.kind', 'operation', 'action', 'edit.type'],
  classify: [
    // 1) tool / function / tool_calls / tool_use 对象存在 → tool_call
    { kind: 'tool_call', when: 'anyPath', paths: ['tool', 'function', 'tool_calls', 'tool_use'] },
    // 2) name + arguments 同时存在 → tool_call
    { kind: 'tool_call', when: 'allPaths', paths: ['name', 'arguments'] },
    // 3) file_path / diff / patch / file_change 存在 → file_change
    { kind: 'file_change', when: 'anyPath', paths: ['file_path', 'filePath', 'diff', 'patch', 'file_change'] },
    // 4) role ∈ {user, human} → user_message
    { kind: 'user_message', when: 'roleEquals', roles: ['user', 'human'] },
    // 5) role ∈ {assistant, model} → assistant_message
    { kind: 'assistant_message', when: 'roleEquals', roles: ['assistant', 'model'] },
    // 其余 → unknown（由内核兜底，不需要规则）
  ],
};

/**
 * 用局部覆盖生成新的字段映射（不修改原对象）。
 * 换真实样本时：只改本文件（DEFAULT_FIELD_MAP 或调用方覆盖），parser.ts 零改动。
 */
export function applyOverrides(base: FieldMap, partial: Partial<FieldMap>): FieldMap {
  return { ...base, ...partial };
}
