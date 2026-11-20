import fs from 'node:fs';
import path from 'node:path';
import { isSceneId } from '../shared/scenes.js';
import { dataDir, defaultWorkspace, legacyDataDir, normalizePath, settingsPath } from './paths.js';
/** 多模型数量上限（防止设置文件与下拉框被写爆）。 */
export const MAX_MODEL_PROFILES = 12;
export function defaultSettings() {
    return {
        apiBaseUrl: 'https://api.openai.com/v1',
        apiKey: '',
        model: 'gpt-4o-mini',
        reasoningEffort: 'auto',
        temperature: 0.6,
        maxOutputTokens: 4096,
        disableThinking: false,
        // 多模型：默认不启用（空列表），行为与没有多模型时完全一致
        modelProfiles: [],
        activeModelId: '',
        // 外观：'dark' 深色（默认）| 'light' 白天
        theme: 'dark',
        // 价格统计：单价按「每百万 tokens」计，均为 0 表示不计费
        priceCacheHit: 0,
        priceInput: 0,
        priceOutput: 0,
        priceCurrency: '¥',
        // 文件改动备份：改动前把原文件复制到 <工作空间>/changed_backup
        changedBackupEnabled: true,
        changedBackupMaxFiles: 200,
        workspacePath: defaultWorkspace(),
        gameRecordFileName: 'work_state.md',
        gameNotesFileName: 'work_notes.md',
        gameSavePath: '',
        allowShell: true,
        shellTimeoutMs: 60_000,
        allowLaunch: true,
        allowPathRequests: true,
        extraWritePaths: '',
        strictReadMode: false,
        allowReadRequests: true,
        extraReadPaths: '',
        // 插件：默认关闭；关闭时插件工具完全不出现在清单与提示词里
        pluginsEnabled: false,
        pluginTimeoutMs: 60_000,
        globalTipsEnabled: true,
        // 工具场景：默认 'general'（不扰动提示词、不增强工具描述，行为与没有该功能时一致）
        toolScene: 'general',
        sceneGuideEnabled: true,
        continuousMode: true,
        continueDelayMs: 1500,
        continuePrompt: '继续。先确认当前状态（读文件/看输出/必要时截图），再推进下一步，并在本轮结束时用 update_work_record 更新工作记录。',
        maxTurns: 500,
        historyMaxMessages: 24,
        clickDelayMs: 60,
        sendScreenshots: true,
        screenshotBurnAfterRead: true,
        maxScreenshotWidth: 1600,
        ocrLanguage: 'zh-Hans',
        ttsEnabled: true,
        ttsEngine: 'Browser',
        ttsVoice: '',
        ttsRate: 0,
        ttsVolume: 0.9,
        cloudTtsBaseUrl: '',
        cloudTtsApiKey: '',
        cloudTtsModel: 'tts-1',
        cloudTtsVoice: 'alloy',
        ttsQueueMode: 'latest',
        ttsQueueLimit: 2,
    };
}
function clampInt(v, def, min, max) {
    const n = typeof v === 'number' ? v : typeof v === 'string' ? Number.parseInt(v, 10) : NaN;
    if (!Number.isFinite(n))
        return def;
    return Math.min(max, Math.max(min, Math.trunc(n)));
}
function clampNum(v, def, min, max) {
    const n = typeof v === 'number' ? v : typeof v === 'string' ? Number.parseFloat(v) : NaN;
    if (!Number.isFinite(n))
        return def;
    return Math.min(max, Math.max(min, n));
}
function str(v, def, maxLen = 4000) {
    return typeof v === 'string' ? v.slice(0, maxLen) : def;
}
function bool(v, def) {
    return typeof v === 'boolean' ? v : def;
}
/**
 * 校验并归一化多模型配置。
 * 密钥字段缺省时沿用同 id 的旧值（浏览器从不回传密钥），因此补丁里只改名称/模型也不会丢密钥。
 * 返回 null 表示补丁未带该字段（调用方保持原值）。
 */
/** 思考强度白名单（口径与全局设置一致：auto = 不发送 reasoning_effort） */
const PROFILE_EFFORTS = ['auto', 'minimal', 'low', 'medium', 'high'];
/** 可选数值：缺省 / 空串 / 非数字 → undefined（表示「沿用全局」，不写覆盖） */
function optNum(v, min, max) {
    if (typeof v === 'number')
        return Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : undefined;
    if (typeof v !== 'string' || !v.trim())
        return undefined;
    const n = Number.parseFloat(v);
    return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : undefined;
}
function optInt(v, min, max) {
    const n = optNum(v, min, max);
    return n === undefined ? undefined : Math.round(n);
}
/**
 * 把浏览器提交的逐项覆盖写进配置。
 * 与全局设置同名同义，但**只写明确的覆盖**：缺省/空串即不设该键，
 * 取用时回落到全局值（见 resolveModelSettings），所以老配置行为零变化。
 */
function applyProfileOverrides(item, o) {
    const effort = str(o.reasoningEffort, '', 20).trim().toLowerCase();
    if (PROFILE_EFFORTS.includes(effort))
        item.reasoningEffort = effort;
    const temperature = optNum(o.temperature, 0, 2);
    if (temperature !== undefined)
        item.temperature = temperature;
    const maxOutputTokens = optInt(o.maxOutputTokens, 256, 384_000);
    if (maxOutputTokens !== undefined)
        item.maxOutputTokens = maxOutputTokens;
    if (typeof o.disableThinking === 'boolean')
        item.disableThinking = o.disableThinking;
    const priceCacheHit = optNum(o.priceCacheHit, 0, 10_000);
    if (priceCacheHit !== undefined)
        item.priceCacheHit = priceCacheHit;
    const priceInput = optNum(o.priceInput, 0, 10_000);
    if (priceInput !== undefined)
        item.priceInput = priceInput;
    const priceOutput = optNum(o.priceOutput, 0, 10_000);
    if (priceOutput !== undefined)
        item.priceOutput = priceOutput;
    const priceCurrency = str(o.priceCurrency, '', 8).trim();
    if (priceCurrency)
        item.priceCurrency = priceCurrency;
}
function sanitizeModelProfiles(raw, prev) {
    if (!Array.isArray(raw))
        return null;
    const prevById = new Map(prev.map((p) => [p.id, p]));
    const used = new Set();
    const out = [];
    let auto = 0;
    for (const entry of raw.slice(0, MAX_MODEL_PROFILES)) {
        if (!entry || typeof entry !== 'object')
            continue;
        const o = entry;
        const model = str(o.model, '', 200).trim();
        // 没有模型名的条目视为还没填完，直接丢弃（不让空条目占着下拉框）
        if (!model)
            continue;
        let id = str(o.id, '', 64).trim();
        if (!/^[A-Za-z0-9_-]{1,64}$/.test(id) || used.has(id)) {
            do {
                auto += 1;
                id = 'm' + auto;
            } while (used.has(id) || prevById.has(id));
        }
        used.add(id);
        const apiKey = typeof o.apiKey === 'string' ? o.apiKey.trim() : (prevById.get(id)?.apiKey ?? '');
        const item = {
            id,
            name: str(o.name, '', 80).trim() || model,
            apiBaseUrl: str(o.apiBaseUrl, '', 500).trim(),
            model,
            apiKey,
        };
        applyProfileOverrides(item, o);
        out.push(item);
    }
    return out;
}
/** 把浏览器提交的补丁合并进现有设置，并做范围校验。密钥字段缺省时保持不变。 */
export function mergeSettings(base, patch) {
    const s = { ...base };
    const p = patch;
    s.apiBaseUrl = str(p.apiBaseUrl, s.apiBaseUrl, 500).trim() || 'https://api.openai.com/v1';
    if (typeof p.apiKey === 'string')
        s.apiKey = p.apiKey.trim();
    s.model = str(p.model, s.model, 200).trim() || s.model;
    const effort = str(p.reasoningEffort, s.reasoningEffort, 20).toLowerCase();
    s.reasoningEffort = ['auto', 'minimal', 'low', 'medium', 'high'].includes(effort) ? effort : 'auto';
    s.temperature = clampNum(p.temperature, s.temperature, 0, 2);
    s.maxOutputTokens = clampInt(p.maxOutputTokens, s.maxOutputTokens, 256, 384_000);
    s.disableThinking = bool(p.disableThinking, s.disableThinking);
    // 多模型：列表缺省表示不改；给了就整批替换（未带 apiKey 的条目沿用同 id 旧密钥）
    const profiles = sanitizeModelProfiles(p.modelProfiles, base.modelProfiles);
    if (profiles)
        s.modelProfiles = profiles;
    const active = str(p.activeModelId, s.activeModelId, 64).trim();
    s.activeModelId = s.modelProfiles.some((m) => m.id === active) ? active : '';
    // 外观：只接受 dark / light，其它值一律回退深色
    const theme = str(p.theme, s.theme, 12).toLowerCase();
    s.theme = theme === 'light' ? 'light' : 'dark';
    // 单价允许小数（常见 0.15 / 2.5 这类报价），上限给到 10000 元/百万以防误输
    s.priceCacheHit = clampNum(p.priceCacheHit, s.priceCacheHit, 0, 10_000);
    s.priceInput = clampNum(p.priceInput, s.priceInput, 0, 10_000);
    s.priceOutput = clampNum(p.priceOutput, s.priceOutput, 0, 10_000);
    s.priceCurrency = str(p.priceCurrency, s.priceCurrency, 8).trim() || '¥';
    s.changedBackupEnabled = bool(p.changedBackupEnabled, s.changedBackupEnabled);
    s.changedBackupMaxFiles = clampInt(p.changedBackupMaxFiles, s.changedBackupMaxFiles, 1, 5000);
    if (typeof p.workspacePath === 'string' && p.workspacePath.trim()) {
        s.workspacePath = normalizePath(p.workspacePath);
    }
    const recName = str(p.gameRecordFileName, s.gameRecordFileName, 120).trim();
    s.gameRecordFileName = recName && !/[\\/:*?"<>|]/.test(recName) ? recName : s.gameRecordFileName;
    const notesName = str(p.gameNotesFileName, s.gameNotesFileName, 120).trim();
    s.gameNotesFileName = notesName && !/[\\/:*?"<>|]/.test(notesName) ? notesName : s.gameNotesFileName;
    if (typeof p.gameSavePath === 'string')
        s.gameSavePath = p.gameSavePath.trim() ? normalizePath(p.gameSavePath) : '';
    s.allowShell = bool(p.allowShell, s.allowShell);
    s.shellTimeoutMs = clampInt(p.shellTimeoutMs, s.shellTimeoutMs, 1000, 1_800_000);
    s.allowLaunch = bool(p.allowLaunch, s.allowLaunch);
    s.allowPathRequests = bool(p.allowPathRequests, s.allowPathRequests);
    s.extraWritePaths = str(p.extraWritePaths, s.extraWritePaths, 4000);
    s.strictReadMode = bool(p.strictReadMode, s.strictReadMode);
    s.allowReadRequests = bool(p.allowReadRequests, s.allowReadRequests);
    s.extraReadPaths = str(p.extraReadPaths, s.extraReadPaths, 4000);
    s.pluginsEnabled = bool(p.pluginsEnabled, s.pluginsEnabled);
    s.pluginTimeoutMs = clampInt(p.pluginTimeoutMs, s.pluginTimeoutMs, 1000, 600_000);
    s.globalTipsEnabled = bool(p.globalTipsEnabled, s.globalTipsEnabled);
    // 工具场景：只接受 scenes.ts 里声明的 id，其余值一律保持原值（不因错字把场景默默改成别的档）
    const scene = str(p.toolScene, s.toolScene, 20).trim().toLowerCase();
    s.toolScene = isSceneId(scene) ? scene : s.toolScene;
    s.sceneGuideEnabled = bool(p.sceneGuideEnabled, s.sceneGuideEnabled);
    s.continuousMode = bool(p.continuousMode, s.continuousMode);
    s.continueDelayMs = clampInt(p.continueDelayMs, s.continueDelayMs, 300, 60_000);
    if (typeof p.continuePrompt === 'string')
        s.continuePrompt = p.continuePrompt.slice(0, 2000);
    s.maxTurns = clampInt(p.maxTurns, s.maxTurns, 0, 100_000);
    s.historyMaxMessages = clampInt(p.historyMaxMessages, s.historyMaxMessages, 10, 400);
    s.clickDelayMs = clampInt(p.clickDelayMs, s.clickDelayMs, 0, 5000);
    s.sendScreenshots = bool(p.sendScreenshots, s.sendScreenshots);
    s.screenshotBurnAfterRead = bool(p.screenshotBurnAfterRead, s.screenshotBurnAfterRead);
    s.maxScreenshotWidth = clampInt(p.maxScreenshotWidth, s.maxScreenshotWidth, 320, 2400);
    s.ocrLanguage = str(p.ocrLanguage, s.ocrLanguage, 30) || 'zh-Hans';
    s.ttsEnabled = bool(p.ttsEnabled, s.ttsEnabled);
    const engine = str(p.ttsEngine, s.ttsEngine, 20);
    s.ttsEngine = engine === 'Cloud' ? 'Cloud' : 'Browser';
    s.ttsVoice = str(p.ttsVoice, s.ttsVoice, 200);
    s.ttsRate = clampInt(p.ttsRate, s.ttsRate, -10, 10);
    s.ttsVolume = clampNum(p.ttsVolume, s.ttsVolume, 0, 1);
    s.cloudTtsBaseUrl = str(p.cloudTtsBaseUrl, s.cloudTtsBaseUrl, 500).trim();
    if (typeof p.cloudTtsApiKey === 'string')
        s.cloudTtsApiKey = p.cloudTtsApiKey.trim();
    s.cloudTtsModel = str(p.cloudTtsModel, s.cloudTtsModel, 100).trim() || 'tts-1';
    s.cloudTtsVoice = str(p.cloudTtsVoice, s.cloudTtsVoice, 100).trim() || 'alloy';
    const qm = str(p.ttsQueueMode, s.ttsQueueMode, 20);
    s.ttsQueueMode = qm === 'off' || qm === 'limit' ? qm : 'latest';
    s.ttsQueueLimit = clampInt(p.ttsQueueLimit, s.ttsQueueLimit, 1, 20);
    return s;
}
export function loadSettings() {
    const file = settingsPath();
    const def = defaultSettings();
    try {
        if (!fs.existsSync(file))
            return migrateLegacySettings(file, def);
        const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
        return mergeSettings(def, raw);
    }
    catch {
        return def;
    }
}
/** 首次启动时从旧版 GameAgent Web 数据目录搬一份设置（含密钥），失败则用默认值。 */
function migrateLegacySettings(targetFile, def) {
    try {
        const legacy = path.join(legacyDataDir(), 'settings.json');
        if (legacy === targetFile || !fs.existsSync(legacy))
            return def;
        const raw = JSON.parse(fs.readFileSync(legacy, 'utf8'));
        const merged = mergeSettings(def, { ...raw, workspacePath: def.workspacePath });
        fs.mkdirSync(path.dirname(targetFile), { recursive: true });
        fs.writeFileSync(targetFile, JSON.stringify(merged, null, 2), { encoding: 'utf8', mode: 0o600 });
        return merged;
    }
    catch {
        return def;
    }
}
let cached = null;
export function getSettings() {
    if (!cached)
        cached = loadSettings();
    return cached;
}
export function updateSettings(patch) {
    const next = mergeSettings(getSettings(), patch);
    const file = settingsPath();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    // 密钥只落盘在服务端数据目录，权限尽量收紧（POSIX）；Windows 依赖用户目录 ACL。
    fs.writeFileSync(file, JSON.stringify(next, null, 2), { encoding: 'utf8', mode: 0o600 });
    cached = next;
    return next;
}
export function dataDirPath() {
    return dataDir();
}
/**
 * 取当前生效的模型配置信息：activeModelId 命中就用它，否则回落到全局设置。
 * 只用于展示，不参与请求构造。
 */
export function activeModelInfo(s) {
    const p = s.activeModelId ? s.modelProfiles.find((m) => m.id === s.activeModelId) : undefined;
    if (!p) {
        return { id: '', name: s.model, model: s.model, apiBaseUrl: s.apiBaseUrl, hasApiKey: !!s.apiKey.trim() };
    }
    return {
        id: p.id,
        name: p.name || p.model,
        model: p.model,
        apiBaseUrl: p.apiBaseUrl || s.apiBaseUrl,
        hasApiKey: !!(p.apiKey.trim() || s.apiKey.trim()),
    };
}
/**
 * 把「当前选中的模型配置」覆盖到设置上，得到真正要发给模型服务商的参数。
 *
 * 规则（就近优先，逐项回落到全局）：
 * - model：用配置里的（必填）
 * - apiBaseUrl：配置里为空则用全局的
 * - apiKey：配置里为空则用全局的（同一服务商下多个模型共用一把钥匙的常见情形）
 *
 * 未启用多模型（activeModelId 为空或找不到）时原样返回入参，保证零配置行为不变。
 */
export function resolveModelSettings(s) {
    if (!s.activeModelId)
        return s;
    const p = s.modelProfiles.find((m) => m.id === s.activeModelId);
    if (!p)
        return s;
    const next = {
        ...s,
        model: p.model,
        apiBaseUrl: p.apiBaseUrl || s.apiBaseUrl,
        apiKey: p.apiKey.trim() || s.apiKey,
    };
    // 逐项覆盖：配置里没填的项一律沿用全局（undefined = 没填）
    if (p.reasoningEffort)
        next.reasoningEffort = p.reasoningEffort;
    if (p.temperature !== undefined)
        next.temperature = p.temperature;
    if (p.maxOutputTokens !== undefined)
        next.maxOutputTokens = p.maxOutputTokens;
    if (p.disableThinking !== undefined)
        next.disableThinking = p.disableThinking;
    if (p.priceCacheHit !== undefined)
        next.priceCacheHit = p.priceCacheHit;
    if (p.priceInput !== undefined)
        next.priceInput = p.priceInput;
    if (p.priceOutput !== undefined)
        next.priceOutput = p.priceOutput;
    if (p.priceCurrency)
        next.priceCurrency = p.priceCurrency;
    return next;
}
/**
 * 切换当前模型。传空字符串表示回到「不使用多模型」的全局配置。
 * 返回实际生效的 id（不存在的 id 会被忽略并回落为 ''）。
 */
export function selectModel(id) {
    const want = String(id ?? '').trim();
    const next = updateSettings({ activeModelId: want });
    return next;
}
//# sourceMappingURL=settings.js.map