import fs from 'node:fs';
import path from 'node:path';
import { dataDir, defaultWorkspace, legacyDataDir, normalizePath, settingsPath } from './paths.js';
export function defaultSettings() {
    return {
        apiBaseUrl: 'https://api.openai.com/v1',
        apiKey: '',
        model: 'gpt-4o-mini',
        reasoningEffort: 'auto',
        temperature: 0.6,
        maxOutputTokens: 4096,
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
//# sourceMappingURL=settings.js.map