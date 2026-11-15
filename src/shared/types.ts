/** 前后端共用的数据模型。浏览器端只接收脱敏后的设置。 */

export type Role = 'system' | 'user' | 'assistant' | 'tool';

export interface ToolCall {
  id: string;
  name: string;
  arguments: string;
}

export interface ChatMessage {
  role: Role;
  content: string;
  reasoning?: string | null;
  toolCalls?: ToolCall[] | null;
  toolCallId?: string | null;
  /** data URL 或服务器图片 id；服务端内部使用 base64 */
  images?: string[] | null;
  /** 阅后即焚：该消息的截图已被模型读过 */
  imageConsumed?: boolean;
}

/** 用户随消息一起提交的附件（图片或文本）。 */
export interface Attachment {
  /** 显示用文件名 */
  name: string;
  mime: string;
  size: number;
  kind: 'image' | 'text';
  /** 文本附件的内容（已在服务端截断） */
  text?: string;
  /** 图片附件的 data URL，或服务端图片 id（/api/images/xxx） */
  dataUrl?: string;
  /** 服务端图片 id，用于时间线回放 */
  imageId?: string;
}

export interface AppSettings {
  // API
  apiBaseUrl: string;
  model: string;
  reasoningEffort: string; // auto|minimal|low|medium|high
  temperature: number;
  maxOutputTokens: number;

  // 工作空间
  workspacePath: string;
  gameRecordFileName: string;
  gameNotesFileName: string;
  gameSavePath: string;

  // 工具权限
  allowShell: boolean;
  shellTimeoutMs: number;
  allowLaunch: boolean;
  /** 允许模型申请工作空间外的可写目录（每次申请需在对话中确认，确认后本会话有效） */
  allowPathRequests: boolean;
  /** 永久放行的额外可写目录（每行一个绝对路径） */
  extraWritePaths: string;
  /** 读取申请（严格模式）：开启后读取工作空间外的路径需先申请并确认；默认关闭 */
  strictReadMode: boolean;
  /** 严格模式下允许模型调用 request_read_access 申请读取；关掉后只能靠白名单 */
  allowReadRequests: boolean;
  /** 永久放行的可读目录（每行一个绝对路径，仅严格模式生效） */
  extraReadPaths: string;

  /** 插件支持：开启后插件声明的工具才会进入工具清单；默认关闭。每次调用都必须经用户审计。 */
  pluginsEnabled: boolean;
  /** 插件单次执行的超时（毫秒），默认 60000 */
  pluginTimeoutMs: number;

  /** 是否把《全局技巧库》附加到提示词（跨会话共享的工具技巧，写入时自动脱敏）。默认开启。 */
  globalTipsEnabled: boolean;

  // 运行
  continuousMode: boolean;
  continueDelayMs: number;
  continuePrompt: string;
  maxTurns: number;
  historyMaxMessages: number;
  clickDelayMs: number;

  // 价格统计（单价按「每百万 tokens」计；三项都为 0 表示不计费）
  priceCacheHit: number;
  priceInput: number;
  priceOutput: number;
  /** 金额前缀（货币符号），默认 ¥ */
  priceCurrency: string;

  // 文件改动备份（改动前把原文件复制到 <工作空间>/changed_backup）
  /** 是否在改动文件前自动备份原内容 */
  changedBackupEnabled: boolean;
  /** 最多保留多少份备份，超出后按时间从旧到新删除 */
  changedBackupMaxFiles: number;

  // 视觉 / OCR
  sendScreenshots: boolean;
  screenshotBurnAfterRead: boolean;
  maxScreenshotWidth: number;
  ocrLanguage: string;

  // 语音
  ttsEnabled: boolean;
  ttsEngine: 'Browser' | 'Cloud';
  ttsVoice: string;
  ttsRate: number;
  ttsVolume: number;
  cloudTtsBaseUrl: string;
  cloudTtsModel: string;
  cloudTtsVoice: string;
  ttsQueueMode: 'off' | 'latest' | 'limit';
  ttsQueueLimit: number;
}

/** 浏览器拿到的设置：密钥只以“已保存/未保存”呈现。 */
export interface PublicSettings extends AppSettings {
  hasApiKey: boolean;
  hasCloudTtsApiKey: boolean;
}

export interface WindowInfo {
  pid: number;
  hwnd: string;
  title: string;
  processName: string;
  width: number;
  height: number;
  isForeground: boolean;
}

export interface TargetWindow {
  pid: number;
  hwnd: string;
  title: string;
  processName: string;
  width: number;
  height: number;
}

export type ChatItemKind = 'user' | 'assistant' | 'thinking' | 'tool' | 'system' | 'error' | 'access';

export interface SessionInfo {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  running: boolean;
  recordLength: number;
  notesLength: number;
}

export interface ChatItem {
  id: string;
  kind: ChatItemKind;
  title?: string;
  text: string;
  detail?: string;
  status?: string;
  meta?: string;
  time: string;
  /** 工具卡片：是否折叠 */
  expanded?: boolean;
  imageUrl?: string | null;
  streaming?: boolean;
  /** 用户消息附带的附件（仅元信息，不含图片数据） */
  attachments?: Attachment[] | null;
  /** 本轮 token 用量（输入/输出），以及其中命中缓存的部分 */
  usage?: {
    promptTokens: number;
    completionTokens: number;
    /** 命中缓存的输入 tokens */
    cachedTokens?: number | null;
    /** 缓存命中数是估算值（服务端未上报） */
    cachedEstimated?: boolean;
  } | null;

  /** 目录授权卡片：申请的可读/可写路径与理由 */
  accessPath?: string;
  accessReason?: string;
  /** 授权类型：read=申请读取，write=申请写入，plugin=插件调用审计（旧数据缺省按 write） */
  accessKind?: 'read' | 'write' | 'plugin';

  /** 插件调用审计卡片：必须让用户看清「这个插件是来干什么的」 */
  pluginId?: string;
  pluginName?: string;
  pluginVersion?: string;
  pluginPurpose?: string;
  pluginTool?: string;
  pluginCommand?: string;
  pluginArgs?: string;
  pluginDir?: string;
  accessStatus?: 'pending' | 'granted' | 'denied';
  accessRequestId?: string;
}

export interface PluginToolInfo {
  /** 插件内工具名 */
  name: string;
  /** 全局工具名 plugin__<插件id>__<工具名> */
  globalName: string;
  /** 工具级用途（审计卡片展示） */
  purpose: string;
}

export interface PluginInfo {
  id: string;
  name: string;
  version: string;
  /** 插件用途：审计时必须展示 */
  purpose: string;
  dir: string;
  enabled: boolean;
  /** 空串表示正常；否则是加载失败原因（该插件不会提供任何工具） */
  error: string;
  tools: PluginToolInfo[];
}

export interface PluginState {
  /** 设置里的总开关（关闭时插件工具完全不出现在清单里） */
  enabled: boolean;
  /** 插件目录 */
  dir: string;
  /** 已写入审计日志的调用次数 */
  auditCount: number;
  items: PluginInfo[];
}

export interface AgentStatus {
  running: boolean;
  status: string;
  turn: number;
  /** 输入总量（含缓存命中） */
  promptTokens: number;
  completionTokens: number;
  /** 累计命中缓存的输入 tokens（= cacheHitTokens 的旧名） */
  cachedTokens: number;
  /** 累计命中缓存的输入 tokens（服务端未上报时为估算值） */
  cacheHitTokens: number;
  /** 累计缓存未命中的输入 tokens（= promptTokens - cacheHitTokens，按输入价计费） */
  cacheMissTokens: number;
  hasSession: boolean;
}

export type ServerEvent =
  | { type: 'state'; sessionId: string; status: AgentStatus }
  | { type: 'item_add'; sessionId: string; item: ChatItem }
  | { type: 'item_update'; sessionId: string; id: string; patch: Partial<ChatItem> }
  | { type: 'clear'; sessionId: string }
  | { type: 'record'; sessionId: string; markdown: string }
  | { type: 'notes'; sessionId: string; markdown: string; length: number }
  | { type: 'target'; sessionId: string; target: TargetWindow | null }
  | { type: 'native'; available: boolean; detail: string }
  | { type: 'sessions'; sessions: SessionInfo[] }
  | { type: 'grants'; sessionId: string; grants: string[] }
  | { type: 'readGrants'; sessionId: string; readGrants: string[] }
  | { type: 'plugins'; plugins: PluginState };

export interface AppState {
  session: { id: string; title: string };
  /** 本会话已授权的额外可写目录 */
  grants: string[];
  /** 本会话已授权的额外可读目录（仅在严格读取模式下起作用） */
  readGrants: string[];
  sessions: SessionInfo[];
  settings: PublicSettings;
  status: AgentStatus;
  target: TargetWindow | null;
  record: string;
  notes: string;
  notesLength: number;
  notesMax: number;
  /** 全局技巧库的容量与条目统计（只给界面展示，内容不随状态下发）。 */
  tips: { count: number; chars: number; max: number };
  /** 文件改动备份的统计（只给界面展示，内容不下发）。 */
  backups: { count: number; bytes: number; folder: string; max: number; enabled: boolean };
  /** 插件清单与审计统计（不含可执行细节） */
  plugins: PluginState;
  timeline: ChatItem[];
  platform: string;
  nativeAvailable: boolean;
  nativeDetail: string;
}