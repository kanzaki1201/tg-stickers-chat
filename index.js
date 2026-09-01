const fs = require('fs');
const path = require('path');
const cp = require('child_process');
const https = require('https');
const Database = require('better-sqlite3');
const { GoogleGenerativeAI } = require('@google/generative-ai');

module.exports = function registerTelegramStickersBrain(api) {
  if (api.registrationMode !== 'full') return;

  const PLUGIN_ID = 'tg-stickers-chat';
  const STATE_DIR = api.runtime.state.resolveStateDir();
  const INDEX_DB_PATH = path.join(STATE_DIR, `${PLUGIN_ID}.sqlite`);
  const TMP_DIR = path.join(STATE_DIR, `${PLUGIN_ID}-tmp`);
  const CORE_CACHE_FILE = path.join(STATE_DIR, 'telegram', 'sticker-cache.json');
  const CORE_STATE_DB = path.join(STATE_DIR, 'state', 'openclaw.sqlite');
  const LEGACY_SEARCH_STATE_FILE = path.join(STATE_DIR, `${PLUGIN_ID}-search-state.json`);

  const SEARCH_RECALL_LIMIT = 36;
  const SEARCH_RECALL_CANDIDATE_WINDOW = 240;
  const SEARCH_HISTORY_LIMIT = 48;
  const SEARCH_HISTORY_TTL_MS = 6 * 60 * 60 * 1000;
  const SEARCH_STICKER_DEDUPE_WINDOW_MS = 10 * 60 * 1000;
  const QUERY_EMBED_CACHE_LIMIT = 256;
  const RECENT_QUEUE_TTL_MS = 10 * 60 * 1000;

  fs.mkdirSync(TMP_DIR, { recursive: true });

  let indexDb = null;
  let searchCacheLoaded = false;
  let searchCacheFingerprint = '';
  let searchCache = [];
  let searchCacheById = new Map();

  let genAI = null;
  let genAIKey = '';
  const modelCache = new Map();
  const queryEmbeddingCache = new Map();

  const syncQueue = [];
  const queuedSets = new Set();
  const recentQueuedSets = new Map();
  let syncRunning = false;
  let legacySelectionStateImported = false;

  function getPluginConfig() {
    return api.config?.plugins?.entries?.[PLUGIN_ID]?.config || {};
  }

  function stripProviderPrefix(modelName) {
    if (!modelName || typeof modelName !== 'string') return '';
    return modelName.includes('/') ? modelName.split('/').pop() : modelName;
  }

  function getEmbeddingApiKey() {
    const config = getPluginConfig();
    const candidates = [
      config.embeddingApiKey,
      process.env.GEMINI_API_KEY,
      process.env.GOOGLE_API_KEY,
    ];

    for (const value of candidates) {
      if (typeof value === 'string' && value.trim()) return value.trim();
    }
    return '';
  }

  function getEmbeddingModelName() {
    return stripProviderPrefix(getPluginConfig().embeddingModel || 'gemini-embedding-2-preview');
  }

  function getEmbeddingDimensions() {
    const raw = Number(getPluginConfig().embeddingDimensions);
    if (Number.isInteger(raw) && raw >= 128 && raw <= 3072) return raw;
    return 768;
  }

  function getAutoCollectEnabled() {
    return getPluginConfig().autoCollect !== false;
  }

  function getBotToken() {
    const token = api.config?.channels?.telegram?.botToken
      || process.env.TELEGRAM_BOT_TOKEN
      || process.env.OPENCLAW_TELEGRAM_BOT_TOKEN
      || '';
    return typeof token === 'string' ? token.trim() : '';
  }

  function normalizeWhitespace(text) {
    return String(text ?? '')
      .replace(/\r/g, '')
      .replace(/\t/g, ' ')
      .replace(/\u00a0/g, ' ')
      .replace(/[ ]{2,}/g, ' ')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
  }

  function parseTs(value) {
    const ts = value ? new Date(value).getTime() : NaN;
    return Number.isFinite(ts) ? ts : 0;
  }

  function safeParseJsonObject(text) {
    const normalized = String(text || '').trim();
    if (!normalized || normalized[0] !== '{') return null;
    try {
      const parsed = JSON.parse(normalized);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
    } catch (_) {
      return null;
    }
  }

  function toTextList(value) {
    if (Array.isArray(value)) {
      return value
        .map((item) => normalizeWhitespace(item))
        .filter(Boolean);
    }
    if (typeof value === 'string' || typeof value === 'number') {
      const normalized = normalizeWhitespace(String(value));
      return normalized ? [normalized] : [];
    }
    return [];
  }

  function uniqueTexts(values) {
    const seen = new Set();
    const result = [];
    for (const value of values) {
      const normalized = normalizeWhitespace(value);
      if (!normalized) continue;
      if (seen.has(normalized)) continue;
      seen.add(normalized);
      result.push(normalized);
    }
    return result;
  }

  function collectTextValues(source, keys) {
    const values = [];
    for (const key of keys) {
      values.push(...toTextList(source?.[key]));
    }
    return uniqueTexts(values);
  }

  function extractLastSentence(text) {
    const normalized = normalizeWhitespace(text);
    if (!normalized) return '';
    const pieces = normalized
      .split(/[\n。！？!?]+/)
      .map((part) => normalizeWhitespace(part))
      .filter(Boolean);
    return pieces.length > 1 ? pieces[pieces.length - 1] : '';
  }

  function normalizeBoolean(value) {
    if (typeof value === 'boolean') return value;
    if (typeof value === 'number') return value !== 0;
    if (typeof value !== 'string') return null;
    const normalized = value.trim().toLowerCase();
    if (!normalized) return null;
    if (['true', '1', 'yes', 'y', 'on', 'send', 'allow', 'required', 'force'].includes(normalized)) return true;
    if (['false', '0', 'no', 'n', 'off', 'skip', 'disable', 'avoid'].includes(normalized)) return false;
    return null;
  }

  function normalizeIntensity(value) {
    if (typeof value === 'number' && Number.isFinite(value)) {
      if (value <= 0.3) return 'low';
      if (value <= 0.65) return 'medium';
      if (value <= 0.9) return 'high';
      return 'max';
    }

    const normalized = normalizeWhitespace(value).toLowerCase();
    if (!normalized) return '';
    if (/^(low|soft|light|轻|低|微弱|淡|克制)/.test(normalized)) return 'low';
    if (/^(medium|mid|normal|moderate|中|普通|正常|适中)/.test(normalized)) return 'medium';
    if (/^(high|strong|big|heavy|高|强|明显|很强|激动)/.test(normalized)) return 'high';
    if (/^(max|extreme|爆炸|拉满|极高|失控|特别强|超强)/.test(normalized)) return 'max';
    return normalized;
  }

  function intensityToChineseLabel(intensity) {
    switch (intensity) {
      case 'low': return '轻';
      case 'medium': return '中';
      case 'high': return '强';
      case 'max': return '拉满';
      default: return normalizeWhitespace(intensity);
    }
  }

  function normalizeStructuredIntent(rawInput) {
    const rawText = normalizeWhitespace(rawInput);
    if (!rawText) {
      throw new Error('Search query is empty');
    }

    const payload = safeParseJsonObject(rawText);
    if (!payload) {
      const plainReplyText = rawText.length >= 12 || /[。！？!?~～]/.test(rawText) ? rawText : '';
      return {
        rawInput: rawText,
        mode: 'plain',
        legacyMode: true,
        replyText: plainReplyText,
        emotions: [],
        acts: [],
        contexts: [],
        keywords: uniqueTexts([rawText]),
        forbid: [],
        intensity: '',
        intensityLabel: '',
        explicitShouldSend: null,
        forceSend: false,
        skipRequested: false,
      };
    }

    const replyText = collectTextValues(payload, [
      'replyText', 'finalReply', 'finalText', 'responseText', 'reply', 'text', 'message', 'content'
    ])[0] || '';
    const emotions = collectTextValues(payload, [
      'emotion', 'emotions', 'mood', 'feeling', 'feelings', 'emotionQuery'
    ]);
    const acts = collectTextValues(payload, [
      'act', 'acts', 'action', 'actions', 'gesture', 'reaction', 'pose', 'movement'
    ]);
    const contexts = collectTextValues(payload, [
      'context', 'contexts', 'scene', 'situation', 'tone', 'tones', 'style', 'styles', 'useCase'
    ]);
    const keywords = collectTextValues(payload, [
      'query', 'keywords', 'tags', 'tag', 'extra', 'extras', 'hint', 'hints'
    ]);
    const forbid = collectTextValues(payload, [
      'forbid', 'forbids', 'avoid', 'avoids', 'exclude', 'excludes', 'ban', 'bans', 'dislike'
    ]);

    const explicitShouldSend = normalizeBoolean(
      payload.shouldSend ?? payload.sendSticker ?? payload.allowSticker
    );
    const forceSend = normalizeBoolean(payload.force ?? payload.requireSticker) === true;
    const skipRequested = normalizeBoolean(payload.skip) === true || explicitShouldSend === false;
    const intensity = normalizeIntensity(payload.intensity ?? payload.energy ?? payload.strength);

    return {
      rawInput: rawText,
      mode: 'structured',
      legacyMode: false,
      replyText,
      emotions,
      acts,
      contexts,
      keywords,
      forbid,
      intensity,
      intensityLabel: intensityToChineseLabel(intensity),
      explicitShouldSend,
      forceSend,
      skipRequested,
    };
  }

  function buildIntentSummary(intent) {
    const chunks = [];

    if (intent.replyText) chunks.push(`回复：${intent.replyText}`);
    if (intent.emotions.length > 0) chunks.push(`情绪：${intent.emotions.join(' / ')}`);
    if (intent.acts.length > 0) chunks.push(`动作：${intent.acts.join(' / ')}`);
    if (intent.contexts.length > 0) chunks.push(`语境：${intent.contexts.join(' / ')}`);
    if (intent.intensityLabel) chunks.push(`强度：${intent.intensityLabel}`);
    if (intent.keywords.length > 0) chunks.push(`补充：${intent.keywords.join(' / ')}`);
    if (intent.forbid.length > 0) chunks.push(`避免：${intent.forbid.join(' / ')}`);

    return chunks.join('；');
  }

  function buildIntentPlan(rawInput) {
    const intent = normalizeStructuredIntent(rawInput);
    const phrases = [];
    const seen = new Set();

    function addPhrase(kind, text, weight) {
      const normalized = normalizeWhitespace(text);
      if (!normalized) return;
      const key = `${kind}:${normalized}`;
      if (seen.has(key)) return;
      seen.add(key);
      phrases.push({ kind, text: normalized, weight });
    }

    if (intent.replyText) {
      addPhrase('reply', intent.replyText, 1.0);
      const tail = extractLastSentence(intent.replyText);
      if (tail && tail !== intent.replyText) addPhrase('tail', tail, 0.93);
    }

    if (intent.emotions.length > 0) {
      addPhrase('emotion', intent.emotions.join(' '), 0.82);
    }

    if (intent.acts.length > 0) {
      addPhrase('act', intent.acts.join(' '), 0.76);
    }

    const contextBits = [];
    if (intent.contexts.length > 0) contextBits.push(intent.contexts.join(' '));
    if (intent.intensityLabel) contextBits.push(`强度 ${intent.intensityLabel}`);
    if (contextBits.length > 0) addPhrase('context', contextBits.join(' '), 0.68);

    const summaryBits = [];
    if (intent.emotions.length > 0) summaryBits.push(intent.emotions.join(' '));
    if (intent.acts.length > 0) summaryBits.push(intent.acts.join(' '));
    if (intent.contexts.length > 0) summaryBits.push(intent.contexts.join(' '));
    if (intent.intensityLabel) summaryBits.push(`情绪强度 ${intent.intensityLabel}`);
    if (intent.keywords.length > 0) summaryBits.push(intent.keywords.join(' '));
    if (summaryBits.length > 0) addPhrase('summary', summaryBits.join(' '), intent.replyText ? 0.9 : 1.0);

    if (intent.forbid.length > 0) {
      addPhrase('forbid', intent.forbid.join(' '), 1.0);
    }

    if (phrases.length === 0) {
      addPhrase('summary', intent.rawInput, 1.0);
    }

    return {
      rawInput: intent.rawInput,
      mode: intent.mode,
      legacyMode: intent.legacyMode,
      intent,
      phrases,
      intentSummary: buildIntentSummary(intent) || intent.rawInput,
    };
  }

  function normalizeVector(values) {
    if (!Array.isArray(values) || values.length === 0) {
      throw new Error('Embedding vector is empty');
    }

    const vector = values.map(Number);
    let sumSq = 0;
    for (const value of vector) {
      if (!Number.isFinite(value)) {
        throw new Error('Embedding vector contains non-finite values');
      }
      sumSq += value * value;
    }

    if (sumSq <= 0) {
      throw new Error('Embedding vector norm is zero');
    }

    const invNorm = 1 / Math.sqrt(sumSq);
    return vector.map((value) => value * invNorm);
  }

  function dotProduct(a, b) {
    const length = Math.min(a.length, b.length);
    let score = 0;
    for (let i = 0; i < length; i += 1) {
      score += a[i] * b[i];
    }
    return score;
  }

  function ensureIndexDb() {
    if (!indexDb) {
      indexDb = new Database(INDEX_DB_PATH);
      indexDb.pragma('journal_mode = WAL');
      indexDb.pragma('synchronous = NORMAL');
      indexDb.exec(`
        CREATE TABLE IF NOT EXISTS stickers_index (
          file_unique_id TEXT PRIMARY KEY,
          file_id TEXT NOT NULL,
          emoji TEXT,
          set_name TEXT,
          description TEXT,
          embedding_json TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_stickers_index_set_name ON stickers_index(set_name);
        CREATE INDEX IF NOT EXISTS idx_stickers_index_updated_at ON stickers_index(updated_at);

        CREATE TABLE IF NOT EXISTS synced_sets (
          set_name TEXT PRIMARY KEY,
          status TEXT NOT NULL,
          total INTEGER NOT NULL DEFAULT 0,
          indexed_count INTEGER NOT NULL DEFAULT 0,
          skipped_count INTEGER NOT NULL DEFAULT 0,
          failed_count INTEGER NOT NULL DEFAULT 0,
          last_synced_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_synced_sets_status ON synced_sets(status);
        CREATE INDEX IF NOT EXISTS idx_synced_sets_last_synced_at ON synced_sets(last_synced_at);

        CREATE TABLE IF NOT EXISTS selection_history (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          file_unique_id TEXT,
          file_id TEXT,
          set_name TEXT,
          intent_text TEXT,
          chosen_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_selection_history_chosen_at ON selection_history(chosen_at DESC);
        CREATE INDEX IF NOT EXISTS idx_selection_history_file_unique_id ON selection_history(file_unique_id);
        CREATE INDEX IF NOT EXISTS idx_selection_history_set_name ON selection_history(set_name);
      `);

      const columns = indexDb.prepare('PRAGMA table_info(stickers_index)').all().map((c) => c.name);
      if (!columns.includes('description')) {
        indexDb.exec('ALTER TABLE stickers_index ADD COLUMN description TEXT');
      }
    }
    return indexDb;
  }

  function checkpointIndexDb() {
    try {
      ensureIndexDb().pragma('wal_checkpoint(TRUNCATE)');
    } catch (e) {
      api.logger.warn(`[Stickers] WAL checkpoint skipped: ${e.message}`);
    }
  }

  function getSearchCacheFingerprint() {
    const row = ensureIndexDb().prepare(`
      SELECT COUNT(*) AS count, COALESCE(MAX(updated_at), '') AS max_updated_at
      FROM stickers_index
    `).get();
    return `${Number(row?.count || 0)}:${String(row?.max_updated_at || '')}`;
  }

  function invalidateSearchCache() {
    searchCacheLoaded = false;
    searchCacheFingerprint = '';
  }

  function loadSearchCache(force = false) {
    const currentFingerprint = getSearchCacheFingerprint();
    if (searchCacheLoaded && !force && searchCacheFingerprint === currentFingerprint) {
      return searchCache;
    }

    const rows = ensureIndexDb().prepare(`
      SELECT file_unique_id, file_id, emoji, set_name, description, embedding_json
      FROM stickers_index
    `).all();

    searchCache = [];
    searchCacheById = new Map();

    for (const row of rows) {
      try {
        const item = {
          fileUniqueId: row.file_unique_id,
          fileId: row.file_id,
          emoji: row.emoji || '',
          setName: row.set_name || '',
          description: row.description || '',
          embedding: JSON.parse(row.embedding_json),
        };
        searchCache.push(item);
        searchCacheById.set(item.fileUniqueId, item);
      } catch (e) {
        api.logger.warn(`[Stickers] Failed to load embedding for ${row.file_unique_id}: ${e.message}`);
      }
    }

    searchCacheLoaded = true;
    searchCacheFingerprint = currentFingerprint;
    api.logger.info(`[Stickers] Loaded ${searchCache.length} sticker embeddings into memory.`);
    return searchCache;
  }

  function hasIndexedSticker(fileUniqueId) {
    if (!fileUniqueId) return false;
    if (searchCacheLoaded) return searchCacheById.has(fileUniqueId);
    const row = ensureIndexDb().prepare('SELECT 1 AS ok FROM stickers_index WHERE file_unique_id = ?').get(fileUniqueId);
    return !!row;
  }

  function hasIndexedStickerRow(fileUniqueId, fileId) {
    if (fileUniqueId) {
      const byUnique = ensureIndexDb().prepare('SELECT 1 AS ok FROM stickers_index WHERE file_unique_id = ?').get(fileUniqueId);
      if (byUnique) return true;
    }
    if (fileId) {
      const byFileId = ensureIndexDb().prepare('SELECT 1 AS ok FROM stickers_index WHERE file_id = ?').get(fileId);
      if (byFileId) return true;
    }
    return false;
  }

  function upsertIndexedSticker(record) {
    ensureIndexDb().prepare(`
      INSERT INTO stickers_index (
        file_unique_id, file_id, emoji, set_name, description, embedding_json, updated_at
      ) VALUES (
        @file_unique_id, @file_id, @emoji, @set_name, @description, @embedding_json, @updated_at
      )
      ON CONFLICT(file_unique_id) DO UPDATE SET
        file_id = excluded.file_id,
        emoji = excluded.emoji,
        set_name = excluded.set_name,
        description = excluded.description,
        embedding_json = excluded.embedding_json,
        updated_at = excluded.updated_at
    `).run(record);

    const cachedItem = {
      fileUniqueId: record.file_unique_id,
      fileId: record.file_id,
      emoji: record.emoji || '',
      setName: record.set_name || '',
      description: record.description || '',
      embedding: JSON.parse(record.embedding_json),
    };

    if (searchCacheLoaded) {
      const existing = searchCacheById.get(cachedItem.fileUniqueId);
      if (existing) {
        existing.fileId = cachedItem.fileId;
        existing.emoji = cachedItem.emoji;
        existing.setName = cachedItem.setName;
        existing.description = cachedItem.description;
        existing.embedding = cachedItem.embedding;
      } else {
        searchCache.push(cachedItem);
        searchCacheById.set(cachedItem.fileUniqueId, cachedItem);
      }
      searchCacheFingerprint = getSearchCacheFingerprint();
    }
  }

  function getIndexedStickerCount() {
    const row = ensureIndexDb().prepare('SELECT COUNT(*) AS count FROM stickers_index').get();
    return Number(row?.count || 0);
  }

  function getCompletedSetCount() {
    const row = ensureIndexDb().prepare(`
      SELECT COUNT(*) AS count
      FROM synced_sets
      WHERE status = 'complete' AND failed_count = 0
    `).get();
    return Number(row?.count || 0);
  }

  function getSetSyncRecord(setName) {
    if (!setName) return null;
    return ensureIndexDb().prepare(`
      SELECT set_name, status, total, indexed_count, skipped_count, failed_count, last_synced_at
      FROM synced_sets
      WHERE set_name = ?
    `).get(setName) || null;
  }

  function hasCompletedSetSync(setName) {
    const row = getSetSyncRecord(setName);
    return !!row
      && row.status === 'complete'
      && Number(row.failed_count || 0) === 0
      && Number(row.total || 0) > 0;
  }

  function recordSetSyncSummary(summary) {
    const failedCount = Number(summary?.failedCount || 0);
    const indexedCount = Number(summary?.indexedCount || 0);
    const skippedCount = Number(summary?.skippedCount || 0);
    const total = Number(summary?.total || 0);
    const status = failedCount > 0
      ? ((indexedCount + skippedCount) > 0 ? 'partial' : 'failed')
      : 'complete';

    ensureIndexDb().prepare(`
      INSERT INTO synced_sets (
        set_name, status, total, indexed_count, skipped_count, failed_count, last_synced_at
      ) VALUES (
        @set_name, @status, @total, @indexed_count, @skipped_count, @failed_count, @last_synced_at
      )
      ON CONFLICT(set_name) DO UPDATE SET
        status = excluded.status,
        total = excluded.total,
        indexed_count = excluded.indexed_count,
        skipped_count = excluded.skipped_count,
        failed_count = excluded.failed_count,
        last_synced_at = excluded.last_synced_at
    `).run({
      set_name: String(summary?.setName || '').trim(),
      status,
      total,
      indexed_count: indexedCount,
      skipped_count: skippedCount,
      failed_count: failedCount,
      last_synced_at: summary?.updatedAt || new Date().toISOString(),
    });
  }

  function pruneSelectionHistory() {
    const cutoff = new Date(Date.now() - SEARCH_HISTORY_TTL_MS).toISOString();
    ensureIndexDb().prepare('DELETE FROM selection_history WHERE chosen_at < ?').run(cutoff);

    const overflow = ensureIndexDb().prepare(`
      SELECT id
      FROM selection_history
      ORDER BY chosen_at DESC, id DESC
      LIMIT -1 OFFSET ?
    `).all(SEARCH_HISTORY_LIMIT);

    if (overflow.length > 0) {
      const deleteStmt = ensureIndexDb().prepare('DELETE FROM selection_history WHERE id = ?');
      const tx = ensureIndexDb().transaction((rows) => {
        for (const row of rows) deleteStmt.run(row.id);
      });
      tx(overflow);
    }
  }

  function importLegacySelectionStateIfNeeded() {
    if (legacySelectionStateImported) return;
    legacySelectionStateImported = true;

    if (!fs.existsSync(LEGACY_SEARCH_STATE_FILE)) return;

    const historyCount = ensureIndexDb().prepare('SELECT COUNT(*) AS count FROM selection_history').get();
    if (Number(historyCount?.count || 0) > 0) return;

    try {
      const parsed = JSON.parse(fs.readFileSync(LEGACY_SEARCH_STATE_FILE, 'utf8'));
      const recentSelections = Array.isArray(parsed?.recentSelections) ? parsed.recentSelections : [];
      if (recentSelections.length === 0) return;

      const insert = ensureIndexDb().prepare(`
        INSERT INTO selection_history (file_unique_id, file_id, set_name, intent_text, chosen_at)
        VALUES (?, ?, ?, ?, ?)
      `);
      const tx = ensureIndexDb().transaction((rows) => {
        for (const entry of rows) {
          const chosenAt = entry?.selectedAt || entry?.chosenAt;
          if (!parseTs(chosenAt)) continue;
          insert.run(
            entry?.fileUniqueId || '',
            entry?.fileId || '',
            entry?.setName || '',
            normalizeWhitespace(entry?.queryText || entry?.intentText || ''),
            new Date(chosenAt).toISOString(),
          );
        }
      });
      tx(recentSelections);
      pruneSelectionHistory();
      api.logger.info(`[Stickers] Imported ${recentSelections.length} legacy search history entries into SQLite.`);
    } catch (e) {
      api.logger.warn(`[Stickers] Failed to import legacy search state: ${e.message}`);
    }
  }

  function listRecentSelections() {
    importLegacySelectionStateIfNeeded();
    pruneSelectionHistory();

    const rows = ensureIndexDb().prepare(`
      SELECT file_unique_id, file_id, set_name, intent_text, chosen_at
      FROM selection_history
      ORDER BY chosen_at DESC, id DESC
      LIMIT ?
    `).all(SEARCH_HISTORY_LIMIT);

    return rows
      .map((row) => ({
        fileUniqueId: row.file_unique_id || '',
        fileId: row.file_id || '',
        setName: row.set_name || '',
        intentText: row.intent_text || '',
        selectedAt: row.chosen_at,
      }))
      .filter((entry) => parseTs(entry.selectedAt) > 0);
  }

  function rememberSearchSelection(result, intentSummary) {
    if (!result?.fileId && !result?.fileUniqueId) return;
    importLegacySelectionStateIfNeeded();

    ensureIndexDb().prepare(`
      INSERT INTO selection_history (file_unique_id, file_id, set_name, intent_text, chosen_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(
      result.fileUniqueId || '',
      result.fileId || '',
      result.setName || '',
      normalizeWhitespace(intentSummary).slice(0, 400),
      new Date().toISOString(),
    );

    pruneSelectionHistory();
  }

  async function bootstrapCompletedSetSync(setName) {
    if (!setName || hasCompletedSetSync(setName)) return true;

    const row = ensureIndexDb().prepare(`
      SELECT COUNT(*) AS count
      FROM stickers_index
      WHERE set_name = ?
    `).get(setName);
    const indexedCount = Number(row?.count || 0);
    if (indexedCount <= 0) return false;

    try {
      const stickerSet = await tgRequest('getStickerSet', { name: setName });
      const total = Array.isArray(stickerSet?.stickers) ? stickerSet.stickers.length : 0;
      if (total > 0 && indexedCount >= total) {
        recordSetSyncSummary({
          setName,
          total,
          indexedCount: 0,
          skippedCount: total,
          failedCount: 0,
          updatedAt: new Date().toISOString(),
        });
        api.logger.info(`[Stickers] Backfilled completed sync state for ${setName} (${indexedCount}/${total}).`);
        return true;
      }
    } catch (e) {
      api.logger.warn(`[Stickers] Failed to verify existing sync state for ${setName}: ${e.message}`);
    }

    return false;
  }

  function readCoreCache() {
    try {
      const db = new Database(CORE_STATE_DB, { readonly: true, fileMustExist: true });
      try {
        const rows = db.prepare(
          "SELECT value_json FROM plugin_state_entries WHERE namespace = 'telegram.sticker-cache'"
        ).all();
        const stickers = {};
        for (const row of rows) {
          try {
            const entry = JSON.parse(row.value_json);
            if (entry && entry.fileUniqueId) stickers[entry.fileUniqueId] = entry;
          } catch {}
        }
        return { stickers };
      } finally {
        db.close();
      }
    } catch (e) {
      api.logger.warn(`[Stickers] Failed to read core sticker cache from SQLite: ${e.message}`);
      return { stickers: {} };
    }
  }

  function getSenderStickers(cache, senderId) {
    return Object.values(cache?.stickers || {})
      .filter((item) => item && item.receivedFrom === `telegram:${senderId}` && item.setName)
      .sort((a, b) => parseTs(b.cachedAt) - parseTs(a.cachedAt));
  }

  function guessMimeType(filePathValue) {
    const ext = String(path.extname(filePathValue || '')).toLowerCase();
    switch (ext) {
      case '.png': return 'image/png';
      case '.jpg':
      case '.jpeg': return 'image/jpeg';
      case '.webp': return 'image/webp';
      case '.gif': return 'image/gif';
      case '.webm': return 'video/webm';
      case '.tgs': return 'application/x-tgsticker';
      default: return 'application/octet-stream';
    }
  }

  async function downloadBuffer(url) {
    return new Promise((resolve, reject) => {
      https.get(url, (res) => {
        if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          resolve(downloadBuffer(res.headers.location));
          return;
        }

        if (res.statusCode !== 200) {
          reject(new Error(`Download failed with status ${res.statusCode}`));
          res.resume();
          return;
        }

        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => resolve(Buffer.concat(chunks)));
      }).on('error', reject);
    });
  }

  function makeTempBase(prefix = 'sticker') {
    return path.join(TMP_DIR, `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`);
  }

  function safeUnlink(filePathValue) {
    try {
      if (filePathValue && fs.existsSync(filePathValue)) fs.unlinkSync(filePathValue);
    } catch (_) {}
  }

  const ANIMATION_FRAME_COUNT = 4;

  /**
   * Sample frames spread across a clip. A single frame cannot distinguish a sticker's
   * opening state from its punchline, which is how "sleepy cat" got indexed as "spit take".
   */
  function extractAnimationFrames(inputPath, tempBase) {
    const probe = cp.spawnSync('ffprobe', [
      '-v', 'error', '-show_entries', 'format=duration',
      '-of', 'default=nw=1:nk=1', inputPath,
    ], { encoding: 'utf8', timeout: 15000 });

    const duration = Number.parseFloat((probe.stdout || '').trim());
    if (!Number.isFinite(duration) || duration <= 0) return [];

    const frames = [];
    for (let j = 0; j < ANIMATION_FRAME_COUNT; j += 1) {
      const at = (duration * (j + 0.5)) / ANIMATION_FRAME_COUNT;
      const framePath = `${tempBase}-f${j}.png`;
      const result = cp.spawnSync('ffmpeg', [
        '-hide_banner', '-loglevel', 'error', '-y',
        '-ss', at.toFixed(3), '-i', inputPath,
        '-frames:v', '1', '-update', '1', framePath,
      ], { encoding: 'utf8', timeout: 20000 });

      if (result.status === 0 && fs.existsSync(framePath)) {
        frames.push(fs.readFileSync(framePath));
        safeUnlink(framePath);
      }
    }
    return frames;
  }

  /**
   * Telegram file paths often carry no extension, so the declared mime type cannot be
   * trusted to spot animation. Sniff the container instead.
   */
  function isAnimatedBuffer(buffer) {
    if (!Buffer.isBuffer(buffer) || buffer.length < 12) return false;
    if (buffer[0] === 0x1a && buffer[1] === 0x45 && buffer[2] === 0xdf && buffer[3] === 0xa3) return true;
    if (buffer.slice(0, 3).toString('latin1') === 'GIF') return true;
    if (buffer.slice(0, 4).toString('latin1') === 'RIFF' && buffer.slice(8, 12).toString('latin1') === 'WEBP') {
      return buffer.slice(12, Math.min(buffer.length, 64)).toString('latin1').includes('ANIM');
    }
    return false;
  }

  function buildPreviewImage(buffer, filePathValue) {
    const mimeType = guessMimeType(filePathValue);
    if (mimeType === 'image/png' || mimeType === 'image/jpeg') {
      return { buffer, frames: [buffer], mimeType, source: 'original' };
    }

    const tempBase = makeTempBase('preview');
    const inputPath = `${tempBase}${path.extname(filePathValue || '') || '.bin'}`;
    const outputPath = `${tempBase}.png`;

    try {
      fs.writeFileSync(inputPath, buffer);

      const isTgs = mimeType === 'application/x-tgsticker' || (filePathValue && filePathValue.endsWith('.tgs'));
      const result = isTgs
        ? cp.spawnSync('/home/k/.openclaw/bin/tgs2png', [inputPath, outputPath], { encoding: 'utf8', timeout: 15000 })
        : cp.spawnSync('ffmpeg', [
            '-hide_banner', '-loglevel', 'error', '-y',
            '-i', inputPath, '-frames:v', '1', outputPath,
          ], { encoding: 'utf8' });

      if (result.status === 0 && fs.existsSync(outputPath)) {
        const firstFrame = fs.readFileSync(outputPath);
        const isAnimated = !isTgs && isAnimatedBuffer(buffer);
        const frames = isAnimated ? extractAnimationFrames(inputPath, tempBase) : [];

        return {
          buffer: firstFrame,
          frames: frames.length > 1 ? frames : [firstFrame],
          mimeType: 'image/png',
          source: isTgs ? 'tgs2png' : (mimeType === 'image/webp' || mimeType === 'image/gif' ? 'ffmpeg-static-convert' : 'ffmpeg'),
        };
      }

      api.logger.warn(`[Stickers] Preview conversion failed for ${filePathValue || 'unknown'}: ${normalizeWhitespace(result.stderr || '') || (isTgs ? 'tgs2png error' : 'unknown ffmpeg error')}`);
      return null;
    } catch (e) {
      api.logger.warn(`[Stickers] Preview conversion error for ${filePathValue || 'unknown'}: ${e.message}`);
      return null;
    } finally {
      safeUnlink(inputPath);
      safeUnlink(outputPath);
    }
  }

  function getEmbeddingModel() {
    const apiKey = getEmbeddingApiKey();
    if (!apiKey) throw new Error('Gemini embedding API key not configured');

    if (!genAI || genAIKey !== apiKey) {
      genAI = new GoogleGenerativeAI(apiKey);
      genAIKey = apiKey;
      modelCache.clear();
      queryEmbeddingCache.clear();
    }

    const modelName = getEmbeddingModelName();
    if (!modelCache.has(modelName)) {
      modelCache.set(modelName, genAI.getGenerativeModel({ model: modelName }));
    }
    return modelCache.get(modelName);
  }

  function extractEmbeddingValues(response) {
    const values = response?.embedding?.values || response?.embedding?.vector || response?.embedding;
    if (!Array.isArray(values) || values.length === 0) {
      throw new Error('Embedding response missing values');
    }
    return values;
  }

  function setCachedQueryEmbedding(key, vector) {
    if (queryEmbeddingCache.has(key)) queryEmbeddingCache.delete(key);
    queryEmbeddingCache.set(key, vector);
    if (queryEmbeddingCache.size > QUERY_EMBED_CACHE_LIMIT) {
      const oldestKey = queryEmbeddingCache.keys().next().value;
      if (oldestKey) queryEmbeddingCache.delete(oldestKey);
    }
  }

  async function embedQueryText(queryText) {
    const normalizedText = normalizeWhitespace(queryText);
    if (!normalizedText) throw new Error('Embedding query text is empty');

    const cacheKey = `${getEmbeddingModelName()}::${getEmbeddingDimensions()}::${normalizedText}`;
    if (queryEmbeddingCache.has(cacheKey)) {
      const cached = queryEmbeddingCache.get(cacheKey);
      queryEmbeddingCache.delete(cacheKey);
      queryEmbeddingCache.set(cacheKey, cached);
      return cached;
    }

    const response = await getEmbeddingModel().embedContent({
      content: { parts: [{ text: normalizedText }] },
      taskType: 'RETRIEVAL_QUERY',
      outputDimensionality: getEmbeddingDimensions(),
    });
    const vector = normalizeVector(extractEmbeddingValues(response));
    setCachedQueryEmbedding(cacheKey, vector);
    return vector;
  }

  const VISION_MODEL = 'deepseek-v4-flash-vision-exp';
  const VISION_PROMPT_FILE = '/home/k/.openclaw/sticker-describe-prompt.txt';
  const VISION_PROMPT_FALLBACK = [
    'Describe this chat sticker for a semantic search index that picks reply stickers.',
    'Picture and text carry the meaning together; many stickers have no text.',
    'Several images mean frames of one animated sticker: describe the whole arc, and do not invent an off-screen cause.',
    'Output lines TEXT / SCENE / EXPRESSION / MEANING / SEND_WHEN / DONT_SEND_WHEN / LIMITS.',
    'Write MEANING, SEND_WHEN and DONT_SEND_WHEN in English then 繁體中文 after a slash.',
  ].join('\n');

  function getVisionPrompt() {
    try {
      const text = fs.readFileSync(VISION_PROMPT_FILE, 'utf8').trim();
      if (text) return text;
    } catch (_) {}
    return VISION_PROMPT_FALLBACK;
  }

  function getOpenAiKey() {
    return process.env.DEEPSEEK_API_KEY || getPluginConfig().visionApiKey || '';
  }

  async function describeStickerWithVision(imageBuffers, imageMimeType) {
    const buffers = (Array.isArray(imageBuffers) ? imageBuffers : [imageBuffers]).filter(Boolean);
    if (!buffers.length || !imageMimeType || !String(imageMimeType).startsWith('image/')) return null;

    const apiKey = getOpenAiKey();
    if (!apiKey) {
      api.logger.warn('[Stickers] Vision describe skipped: DEEPSEEK_API_KEY not set');
      return null;
    }

    const content = [{ type: 'text', text: getVisionPrompt() }];
    for (const buf of buffers) {
      content.push({
        type: 'image_url',
        image_url: { url: `data:image/png;base64,${buf.toString('base64')}` },
      });
    }

    try {
      const res = await fetch('https://api.deepseek.com/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model: VISION_MODEL,
          messages: [{ role: 'user', content }],
        }),
        signal: AbortSignal.timeout(180000),
      });

      if (!res.ok) {
        api.logger.warn(`[Stickers] Vision describe failed: HTTP ${res.status}`);
        return null;
      }

      const data = await res.json();
      return data?.choices?.[0]?.message?.content?.trim() || null;
    } catch (err) {
      api.logger.warn(`[Stickers] Vision describe failed: ${err.message}`);
      return null;
    }
  }

  async function embedStickerDocument({ imageBuffer, imageMimeType, emoji, setName, fileUniqueId, description }) {
    const parts = [];

    if (imageBuffer && imageMimeType && String(imageMimeType).startsWith('image/')) {
      parts.push({
        inlineData: {
          data: imageBuffer.toString('base64'),
          mimeType: imageMimeType,
        }
      });
    }

    const metadataText = [
      'telegram sticker',
      emoji ? `emoji: ${emoji}` : '',
      setName ? `set: ${setName}` : '',
      fileUniqueId ? `id: ${fileUniqueId}` : '',
      description ? `description: ${description}` : '',
    ].filter(Boolean).join('\n');

    if (metadataText) parts.push({ text: metadataText });
    if (parts.length === 0) throw new Error('No image preview or metadata available to embed');

    const response = await getEmbeddingModel().embedContent({
      content: { parts },
      taskType: 'RETRIEVAL_DOCUMENT',
      title: setName || fileUniqueId || 'telegram-sticker',
      outputDimensionality: getEmbeddingDimensions(),
    });

    return normalizeVector(extractEmbeddingValues(response));
  }

  async function tgRequest(method, params = {}) {
    const token = getBotToken();
    if (!token) throw new Error('Telegram bot token not found');

    return new Promise((resolve, reject) => {
      const req = https.request(`https://api.telegram.org/bot${token}/${method}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      }, (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => {
          try {
            const result = JSON.parse(data);
            if (result.ok) resolve(result.result);
            else reject(new Error(result.description || `Telegram API error: ${method}`));
          } catch (e) {
            reject(new Error(`Failed to parse Telegram API response for ${method}: ${e.message}`));
          }
        });
      });

      req.on('error', reject);
      req.write(JSON.stringify(params));
      req.end();
    });
  }

  async function indexSticker({ sticker, setName, force = false }) {
    if (!sticker?.file_id || !sticker?.file_unique_id) {
      throw new Error('Sticker is missing file identifiers');
    }

    if (!force && hasIndexedSticker(sticker.file_unique_id)) {
      return { skipped: true, reason: 'already-indexed' };
    }

    const fileInfo = await tgRequest('getFile', { file_id: sticker.file_id });
    if (!fileInfo?.file_path) {
      throw new Error(`Telegram did not return file_path for ${sticker.file_unique_id}`);
    }

    const downloadUrl = `https://api.telegram.org/file/bot${getBotToken()}/${fileInfo.file_path}`;
    const originalBuffer = await downloadBuffer(downloadUrl);
    const previewImage = buildPreviewImage(originalBuffer, fileInfo.file_path);

    const description = await describeStickerWithVision(
      previewImage?.frames || previewImage?.buffer || null,
      previewImage?.mimeType || '',
    );

    const vector = await embedStickerDocument({
      imageBuffer: previewImage?.buffer || null,
      imageMimeType: previewImage?.mimeType || '',
      emoji: sticker.emoji || '',
      setName: setName || '',
      fileUniqueId: sticker.file_unique_id,
      description: description || '',
    });

    upsertIndexedSticker({
      file_unique_id: sticker.file_unique_id,
      file_id: sticker.file_id,
      emoji: sticker.emoji || '',
      set_name: setName || '',
      description: description || '',
      embedding_json: JSON.stringify(vector),
      updated_at: new Date().toISOString(),
    });

    return {
      skipped: false,
      source: previewImage?.source || 'metadata-only',
    };
  }

  async function syncStickerSet(setName) {
    const stickerSet = await tgRequest('getStickerSet', { name: setName });
    const stickers = Array.isArray(stickerSet?.stickers) ? stickerSet.stickers : [];

    let indexedCount = 0;
    let skippedCount = 0;
    let failedCount = 0;

    for (const sticker of stickers) {
      try {
        const result = await indexSticker({ sticker, setName });
        if (result.skipped) skippedCount += 1;
        else indexedCount += 1;
      } catch (e) {
        failedCount += 1;
        api.logger.warn(`[Stickers] Failed to index ${sticker?.file_unique_id || 'unknown'} in ${setName}: ${e.message}`);
      }
    }

    checkpointIndexDb();
    const summary = {
      setName,
      total: stickers.length,
      indexedCount,
      skippedCount,
      failedCount,
      updatedAt: new Date().toISOString(),
    };
    recordSetSyncSummary(summary);
    return summary;
  }

  async function embedIntentPlan(plan) {
    const embedded = [];
    for (const phrase of plan.phrases) {
      embedded.push({
        ...phrase,
        vector: await embedQueryText(phrase.text),
      });
    }

    return {
      ...plan,
      phrases: embedded,
    };
  }

  function scoreWithPhrases(item, phrases, allowedKinds) {
    const allowedSet = allowedKinds ? new Set(allowedKinds) : null;
    let best = -Infinity;
    let matchedText = '';

    for (const phrase of phrases) {
      if (allowedSet && !allowedSet.has(phrase.kind)) continue;
      const score = dotProduct(phrase.vector, item.embedding) * (Number(phrase.weight) || 1);
      if (score > best) {
        best = score;
        matchedText = phrase.text;
      }
    }

    return {
      score: Number.isFinite(best) ? best : -Infinity,
      matchedText,
    };
  }

  function annotateTopCandidates(candidates) {
    const seenSetCounts = new Map();
    return candidates.map((candidate, index) => {
      const setKey = candidate.setName || `__no_set__:${candidate.fileUniqueId}`;
      const sameSetAhead = seenSetCounts.get(setKey) || 0;
      seenSetCounts.set(setKey, sameSetAhead + 1);
      return {
        ...candidate,
        baseRank: index + 1,
        sameSetAhead,
      };
    });
  }

  function buildDiversifiedRecallPool(scoredCandidates, limit = SEARCH_RECALL_LIMIT) {
    const windowed = scoredCandidates.slice(0, Math.max(limit, SEARCH_RECALL_CANDIDATE_WINDOW));
    if (windowed.length <= limit) return windowed;

    const selected = [];
    const selectedKeys = new Set();
    const perSetCounts = new Map();

    for (let roundCap = 1; selected.length < limit; roundCap += 1) {
      let addedThisRound = 0;

      for (const candidate of windowed) {
        if (selected.length >= limit) break;
        const itemKey = candidate.fileUniqueId || candidate.fileId;
        if (!itemKey || selectedKeys.has(itemKey)) continue;

        const setKey = candidate.setName || `__no_set__:${itemKey}`;
        const currentCount = perSetCounts.get(setKey) || 0;
        if (currentCount >= roundCap) continue;

        selected.push(candidate);
        selectedKeys.add(itemKey);
        perSetCounts.set(setKey, currentCount + 1);
        addedThisRound += 1;
      }

      if (addedThisRound === 0) break;
    }

    if (selected.length < limit) {
      for (const candidate of windowed) {
        if (selected.length >= limit) break;
        const itemKey = candidate.fileUniqueId || candidate.fileId;
        if (!itemKey || selectedKeys.has(itemKey)) continue;
        selected.push(candidate);
        selectedKeys.add(itemKey);
      }
    }

    return selected;
  }

  function getRecentSelectionStats(recentSelections, candidate) {
    const stats = {
      recentStickerHits: 0,
      recentSetHits: 0,
      sameSetStreak: 0,
      latestStickerAgeMs: null,
    };

    let streakOpen = true;
    const now = Date.now();

    for (const entry of recentSelections) {
      const ageMs = now - parseTs(entry.selectedAt);
      if (!Number.isFinite(ageMs) || ageMs < 0) continue;

      if (candidate.fileUniqueId && entry.fileUniqueId === candidate.fileUniqueId) {
        stats.recentStickerHits += 1;
        if (stats.latestStickerAgeMs === null || ageMs < stats.latestStickerAgeMs) {
          stats.latestStickerAgeMs = ageMs;
        }
      }

      if (candidate.setName && entry.setName === candidate.setName) {
        stats.recentSetHits += 1;
        if (streakOpen) stats.sameSetStreak += 1;
      } else if (streakOpen) {
        streakOpen = false;
      }
    }

    return stats;
  }

  function computeRepeatPenalty(candidate, recentSelections) {
    const stats = getRecentSelectionStats(recentSelections, candidate);
    let penalty = 0;

    if (candidate.sameSetAhead > 0 && candidate.setName) {
      penalty += Math.min(0.06, candidate.sameSetAhead * 0.016);
    }

    if (stats.sameSetStreak > 0 && candidate.setName) {
      penalty += Math.min(0.14, stats.sameSetStreak * 0.026);
    }

    if (stats.recentSetHits > 0 && candidate.setName) {
      penalty += Math.min(0.08, stats.recentSetHits * 0.012);
    }

    if (stats.recentStickerHits > 0) {
      penalty += Math.min(0.18, stats.recentStickerHits * 0.08);
      if (stats.latestStickerAgeMs !== null && stats.latestStickerAgeMs < SEARCH_STICKER_DEDUPE_WINDOW_MS) {
        penalty += 0.12;
      }
    }

    return { penalty, recentStats: stats };
  }

  function computeMetadataAdjustment(candidate, embeddedPlan) {
    const replyText = embeddedPlan.intent.replyText || '';
    let bonus = 0;
    let penalty = 0;

    if (candidate.emoji && replyText.includes(candidate.emoji)) {
      bonus += 0.018;
    }

    if (candidate.setName && embeddedPlan.intent.forbid.some((text) => candidate.setName.includes(text))) {
      penalty += 0.12;
    }

    if (candidate.emoji && embeddedPlan.intent.forbid.some((text) => text.includes(candidate.emoji))) {
      penalty += 0.08;
    }

    return { bonus, penalty };
  }

  function computeSemanticScore(candidate, embeddedPlan) {
    const reply = scoreWithPhrases(candidate, embeddedPlan.phrases, ['reply', 'tail']);
    const emotion = scoreWithPhrases(candidate, embeddedPlan.phrases, ['emotion']);
    const act = scoreWithPhrases(candidate, embeddedPlan.phrases, ['act']);
    const context = scoreWithPhrases(candidate, embeddedPlan.phrases, ['context']);
    const summary = scoreWithPhrases(candidate, embeddedPlan.phrases, ['summary']);
    const forbid = scoreWithPhrases(candidate, embeddedPlan.phrases, ['forbid']);

    const components = [];

    if (Number.isFinite(reply.score)) components.push({ key: 'reply', value: reply.score, weight: 0.44 });
    if (Number.isFinite(emotion.score)) components.push({ key: 'emotion', value: emotion.score, weight: 0.2 });
    if (Number.isFinite(act.score)) components.push({ key: 'act', value: act.score, weight: 0.14 });
    if (Number.isFinite(context.score)) components.push({ key: 'context', value: context.score, weight: 0.1 });
    if (Number.isFinite(summary.score)) components.push({ key: 'summary', value: summary.score, weight: components.length > 0 ? 0.12 : 1.0 });

    const totalWeight = components.reduce((sum, item) => sum + item.weight, 0) || 1;
    const semanticScore = components.reduce((sum, item) => sum + (item.value * item.weight), 0) / totalWeight;
    const forbidPenalty = Number.isFinite(forbid.score) ? Math.max(0, forbid.score) * 0.28 : 0;

    return {
      semanticScore,
      componentScores: {
        reply: Number.isFinite(reply.score) ? reply.score : null,
        emotion: Number.isFinite(emotion.score) ? emotion.score : null,
        act: Number.isFinite(act.score) ? act.score : null,
        context: Number.isFinite(context.score) ? context.score : null,
        summary: Number.isFinite(summary.score) ? summary.score : null,
        forbid: Number.isFinite(forbid.score) ? forbid.score : null,
      },
      matchedTexts: uniqueTexts([
        reply.matchedText,
        emotion.matchedText,
        act.matchedText,
        context.matchedText,
        summary.matchedText,
      ]),
      forbidPenalty,
    };
  }

  function rerankCandidatePool(candidates, embeddedPlan, recentSelections) {
    return candidates.map((candidate) => {
      const semantic = computeSemanticScore(candidate, embeddedPlan);
      const repeatAdjustment = computeRepeatPenalty(candidate, recentSelections);
      const metadataAdjustment = computeMetadataAdjustment(candidate, embeddedPlan);
      const bonus = metadataAdjustment.bonus;
      const penalty = repeatAdjustment.penalty + metadataAdjustment.penalty + semantic.forbidPenalty;

      return {
        ...candidate,
        semanticScore: semantic.semanticScore,
        finalScore: semantic.semanticScore + bonus - penalty,
        componentScores: semantic.componentScores,
        matchedIntentTexts: semantic.matchedTexts,
        bonus,
        penalty,
        recentStats: repeatAdjustment.recentStats,
      };
    }).sort((a, b) => {
      if (b.finalScore !== a.finalScore) return b.finalScore - a.finalScore;
      return b.baseScore - a.baseScore;
    });
  }

  function isStickerFriendlyReply(intent) {
    if (!intent.replyText) return true;
    const text = intent.replyText;
    if (text.length > 240) return false;
    if ((text.match(/\n/g) || []).length >= 5) return false;
    if (/```/.test(text)) return false;
    if (/https?:\/\//i.test(text)) return false;
    if (/^\s*[-*]\s/m.test(text) || /^\s*\d+\.\s/m.test(text)) return false;
    return true;
  }

  function estimateExpressionNeed(intent) {
    let score = 0;
    if (intent.emotions.length > 0) score += 0.8;
    if (intent.acts.length > 0) score += 0.55;
    if (intent.contexts.length > 0) score += 0.2;
    if (intent.intensity === 'low') score += 0.12;
    if (intent.intensity === 'medium') score += 0.22;
    if (intent.intensity === 'high') score += 0.35;
    if (intent.intensity === 'max') score += 0.45;
    if (intent.replyText && intent.replyText.length <= 28) score += 0.12;
    if (/[！!？?~～哈哈嘿呀哇呜啦欸耶]/.test(intent.replyText || '')) score += 0.2;
    if (/(抱抱|哭哭|笑死|好耶|呜呜|欸嘿|嘿嘿|拜托|求求|气死|离谱|无语|谢谢啦|辛苦啦)/.test(intent.replyText || '')) score += 0.16;
    return clamp(score / 1.6, 0, 1);
  }

  function estimateCandidateConfidence(topCandidate, secondCandidate) {
    if (!topCandidate) return 0;
    const baseConfidence = clamp((topCandidate.finalScore - 0.12) / 0.32, 0, 1);
    const margin = topCandidate.finalScore - Number(secondCandidate?.finalScore || 0);
    const marginConfidence = clamp((margin - 0.004) / 0.045, 0, 1);
    const penaltyConfidence = clamp(1 - (topCandidate.penalty / 0.34), 0, 1);
    return clamp((baseConfidence * 0.55) + (marginConfidence * 0.25) + (penaltyConfidence * 0.2), 0, 1);
  }

  function decideStickerSend(embeddedPlan, reranked) {
    const intent = embeddedPlan.intent;
    const topCandidate = reranked[0] || null;
    const secondCandidate = reranked[1] || null;

    if (!topCandidate) {
      return {
        shouldSend: false,
        confidence: 0,
        reason: 'no-candidate',
      };
    }

    if (intent.skipRequested && !intent.forceSend) {
      return {
        shouldSend: false,
        confidence: 0,
        reason: 'explicit-skip',
      };
    }

    if (!isStickerFriendlyReply(intent) && !intent.forceSend) {
      return {
        shouldSend: false,
        confidence: 0.1,
        reason: 'reply-format-not-suitable',
      };
    }

    const confidence = estimateCandidateConfidence(topCandidate, secondCandidate);
    const expressionNeed = estimateExpressionNeed(intent);
    const combinedScore = clamp((confidence * 0.7) + (expressionNeed * 0.3), 0, 1);

    if (intent.forceSend) {
      return {
        shouldSend: confidence >= 0.18,
        confidence,
        reason: confidence >= 0.18 ? 'forced-send' : 'forced-but-low-confidence',
      };
    }

    if (intent.legacyMode) {
      return {
        shouldSend: true,
        confidence,
        reason: 'legacy-query',
      };
    }

    if (intent.explicitShouldSend === true) {
      return {
        shouldSend: confidence >= 0.24,
        confidence,
        reason: confidence >= 0.24 ? 'explicit-send' : 'explicit-send-low-confidence',
      };
    }

    if (combinedScore < 0.38) {
      return {
        shouldSend: false,
        confidence,
        reason: 'low-confidence',
      };
    }

    if (expressionNeed < 0.18 && confidence < 0.52) {
      return {
        shouldSend: false,
        confidence,
        reason: 'text-not-expressive-enough',
      };
    }

    return {
      shouldSend: true,
      confidence,
      reason: 'intent-aligned',
    };
  }

  async function searchSticker(rawInput) {
    const embeddedPlan = await embedIntentPlan(buildIntentPlan(rawInput));

    for (let attempt = 0; attempt < 2; attempt += 1) {
      loadSearchCache(attempt > 0);
      if (searchCache.length === 0) throw new Error('Sticker index is empty');

      const recalled = buildDiversifiedRecallPool(
        searchCache
          .map((item) => ({
            ...item,
            baseScore: scoreWithPhrases(item, embeddedPlan.phrases, ['reply', 'tail', 'emotion', 'act', 'context', 'summary']).score,
          }))
          .sort((a, b) => b.baseScore - a.baseScore),
        SEARCH_RECALL_LIMIT,
      );

      if (recalled.length === 0) throw new Error('No sticker candidates found');

      const reranked = rerankCandidatePool(
        annotateTopCandidates(recalled),
        embeddedPlan,
        listRecentSelections(),
      );

      const decision = decideStickerSend(embeddedPlan, reranked);
      const topCandidate = reranked[0] || null;

      if (topCandidate && hasIndexedStickerRow(topCandidate.fileUniqueId, topCandidate.fileId)) {
        return {
          shouldSend: decision.shouldSend,
          confidence: decision.confidence,
          reason: decision.reason,
          sticker: decision.shouldSend ? {
            fileId: topCandidate.fileId,
            fileUniqueId: topCandidate.fileUniqueId,
            setName: topCandidate.setName,
            score: topCandidate.finalScore,
            baseScore: topCandidate.baseScore,
            semanticScore: topCandidate.semanticScore,
            penalty: topCandidate.penalty,
            bonus: topCandidate.bonus,
            source: attempt > 0
              ? `embedding2-intent-topk-rerank-refreshed/${embeddedPlan.mode}`
              : `embedding2-intent-topk-rerank/${embeddedPlan.mode}`,
            matchedIntentText: topCandidate.matchedIntentTexts[0] || embeddedPlan.intentSummary,
            componentScores: topCandidate.componentScores,
          } : null,
          topCandidate: topCandidate ? {
            fileId: topCandidate.fileId,
            fileUniqueId: topCandidate.fileUniqueId,
            setName: topCandidate.setName,
            score: topCandidate.finalScore,
            baseScore: topCandidate.baseScore,
            semanticScore: topCandidate.semanticScore,
            penalty: topCandidate.penalty,
            bonus: topCandidate.bonus,
            matchedIntentTexts: topCandidate.matchedIntentTexts,
            componentScores: topCandidate.componentScores,
          } : null,
          runnerUp: reranked[1] ? {
            fileId: reranked[1].fileId,
            fileUniqueId: reranked[1].fileUniqueId,
            setName: reranked[1].setName,
            score: reranked[1].finalScore,
          } : null,
          intentSummary: embeddedPlan.intentSummary,
          plan: embeddedPlan,
        };
      }

      api.logger.warn(`[Stickers] Search candidates for "${embeddedPlan.rawInput}" were stale after rerank; invalidating cache and retrying.`);
      invalidateSearchCache();
    }

    throw new Error('Top sticker candidates became stale after cache refresh');
  }

  function normalizeSetName(value) {
    let text = String(value || '').trim();
    if (!text) return '';

    text = text.replace(/^https?:\/\/t\.me\/addstickers\//i, '');
    text = text.replace(/^https?:\/\/telegram\.me\/addstickers\//i, '');
    text = text.split('?')[0].trim();
    return text;
  }

  async function processSyncQueue() {
    if (syncRunning) return;
    syncRunning = true;

    try {
      while (syncQueue.length > 0) {
        const setName = syncQueue.shift();
        try {
          api.logger.info(`[Stickers] Syncing set: ${setName}`);
          const summary = await syncStickerSet(setName);
          api.logger.info(`[Stickers] Set ${setName} synced (${summary.indexedCount} indexed, ${summary.skippedCount} skipped, ${summary.failedCount} failed).`);
        } catch (e) {
          api.logger.error(`[Stickers] Error syncing set ${setName}: ${e.message}`);
        } finally {
          queuedSets.delete(setName);
        }
      }
    } finally {
      syncRunning = false;
    }
  }

  async function queueSetOnce(setName, reason = 'manual') {
    if (!setName) return { queued: false, reason: 'empty' };

    if (hasCompletedSetSync(setName) || await bootstrapCompletedSetSync(setName)) {
      api.logger.info(`[Stickers] Skipping already-synced set ${setName} (${reason})`);
      return { queued: false, reason: 'already-synced' };
    }

    const now = Date.now();
    const lastQueuedAt = recentQueuedSets.get(setName) || 0;
    if (queuedSets.has(setName) || (now - lastQueuedAt) < RECENT_QUEUE_TTL_MS) {
      return { queued: false, reason: 'already-queued' };
    }

    recentQueuedSets.set(setName, now);
    queuedSets.add(setName);
    syncQueue.push(setName);
    api.logger.info(`[Stickers] Queued set ${setName} (${reason})`);
    processSyncQueue().catch((e) => {
      api.logger.error(`[Stickers] Queue processing crashed: ${e.message}`);
    });
    return { queued: true, reason: 'queued' };
  }

  function buildToolResultText(result) {
    const chosenId = result.sticker?.fileUniqueId;
    const chosen = chosenId ? searchCacheById.get(chosenId) : null;

    const payload = {
      should_send: result.shouldSend,
      confidence: Number((result.confidence || 0).toFixed(4)),
      reason: result.reason,
      sticker_id: result.sticker?.fileId || undefined,
      set_name: result.sticker?.setName || result.topCandidate?.setName || undefined,
      matched_intent: result.sticker?.matchedIntentText || result.intentSummary,
      source: result.sticker?.source || undefined,
      score: typeof result.sticker?.score === 'number' ? Number(result.sticker.score.toFixed(4)) : undefined,
      // The agent cannot see the sticker it is about to send; this is its only look at it.
      description: chosen?.description || result.sticker?.description || undefined,
    };

    if (result.topCandidate?.componentScores) {
      payload.component_scores = Object.fromEntries(
        Object.entries(result.topCandidate.componentScores)
          .filter(([, value]) => typeof value === 'number' && Number.isFinite(value))
          .map(([key, value]) => [key, Number(value.toFixed(4))])
      );
    }

    return JSON.stringify(payload);
  }

  function buildPromptGuidance() {
    return [
      'Telegram 贴纸 tool use（tg-stickers-chat）',
      '',
      '步骤',
      '需要贴纸时：',
      '1. 先确定最终文字 `replyText`。',
      '2. 单独调用 `select_sticker_for_reply`。',
      '3. 等结果返回。',
      '4. 先读 `description`——你看不见贴图本身，这段文字是你唯一能看到的画面内容。对照 `MEANING` / `SEND_WHEN` / `DONT_SEND_WHEN` / `LIMITS`：跟你想表达的不一致（例如你想撒娇、它却是拒绝或过节专用），就当作 `should_send=false`，只发文字，或换个 `emotion` 重新 `select_sticker_for_reply` 一次。分数高不等于贴切。',
      '5. 如果 `should_send=true`、有 `sticker_id`、而且 `description` 对得上：调用 `message(action="sticker", stickerId=[sticker_id])` 发送贴纸。注意：`stickerId` 必须是数组。',
      '5. 再发送文字：`message(action="send", message=replyText)`。',
      '6. 最终输出 `NO_REPLY`。',
      '不需要贴纸时：',
      '- 要么直接自然语言回复。',
      '- 要么调用 `message(action="send", message=replyText)`，然后最终输出 `NO_REPLY`。',
      '- 不要两种都做。',
      '',
      '正确范例',
      '- 需要贴纸：先 `select_sticker_for_reply({...})`，等结果，再 `message(action="sticker", stickerId=[result.sticker_id])`，再 `message(action="send", message=replyText)`，最后 `NO_REPLY`。',
      '- 不需要贴纸：直接自然语言回复；或者 `message(action="send", message=replyText)` 后 `NO_REPLY`。',
      '',
      '错误范例',
      '- `parallel(select_sticker_for_reply(...), message(action="sticker", ...), message(action="send", ...))`',
      '- `message(action="send", message="CAACAg...")`',
      '- `message(action="sticker", stickerId="CAACAg...")`',
      '- 先发旧 `stickerId`，再等选择结果。',
      '- 在 `message(action="send")` 之后又自然语言重复同一段话。',
      '- 贴纸失败后，把已经成功发过的文字再重发一次。',
      '',
      '注意事项',
      '- `select_sticker_for_reply` 只负责选贴纸，不负责发送。',
      '- `message(action="sticker")` 才是发送贴纸。',
      '- `stickerId` 必须是数组：`["CAACAg..."]`。',
      '- 整条链路必须严格串行，不要并行。',
      '- 如果 `should_send=false`、没有 `sticker_id`、或贴纸不贴切，就只发文字。',
      '- 如果当前没有 `select_sticker_for_reply`，就调用 `search_sticker_by_emotion`，把包含 `replyText` / `emotion` / `act` / `intensity` / `context` / `forbid` 的 JSON 字符串放进 `query`。不要向用户追问搜索关键词。',
      '- 只要用了 `message(action="send")` 发用户可见文字，最终就必须是 `NO_REPLY`。',
      '- 失败补救时，只补失败的那一步；不要重发已经成功的文字。',
    ].join('\n');
  }

  if (api.on) {
    api.on('before_prompt_build', (event) => {
      try {
        const messages = Array.isArray(event?.messages) ? event.messages : [];
        const lastMessage = messages[messages.length - 1];
        const channel = lastMessage?.metadata?.channel || lastMessage?.metadata?.originatingChannel || lastMessage?.channel;
        if (channel && channel !== 'telegram') return undefined;
      } catch (_) {}

      return {
        prependSystemContext: buildPromptGuidance(),
      };
    });

    api.on('message_received', async (event) => {
      const channel = event.metadata?.channel || event.metadata?.originatingChannel;
      if (channel !== 'telegram') return;
      if (!getAutoCollectEnabled()) return;
      if (!event.content || (!event.content.includes('<media:sticker>') && !event.content.includes('sticker'))) return;

      let senderId;
      let baselineLatestTs = 0;

      try {
        senderId = event.metadata?.senderId || event.from?.split(':')?.[1];
        if (!senderId) return;
        const cache = readCoreCache();
        const existing = getSenderStickers(cache, senderId);
        baselineLatestTs = existing.length > 0 ? parseTs(existing[0].cachedAt) : 0;
      } catch (e) {
        api.logger.warn(`[Stickers] Failed to capture baseline sticker cache: ${e.message}`);
      }

      setTimeout(async () => {
        try {
          if (!senderId) return;
          const cache = readCoreCache();
          const senderStickers = getSenderStickers(cache, senderId);
          if (senderStickers.length === 0) return;

          const newStickers = senderStickers.filter((item) => parseTs(item.cachedAt) > baselineLatestTs + 1);
          let matchedSticker = newStickers[0] || null;

          if (!matchedSticker) {
            const now = Date.now();
            const recent = senderStickers.filter((item) => (now - parseTs(item.cachedAt)) <= 15 * 1000);
            const uniqueRecentSets = [...new Set(recent.map((item) => item.setName))];
            if (recent.length === 1 || uniqueRecentSets.length === 1) {
              matchedSticker = recent[0];
              api.logger.info(`[Stickers] Falling back to recent sticker match for sender ${senderId}: ${matchedSticker.setName}`);
            }
          }

          if (!matchedSticker?.setName) {
            api.logger.warn('[Stickers] Could not confidently resolve sticker set from cache; skipping auto-sync to avoid false positives.');
            return;
          }

          await queueSetOnce(matchedSticker.setName, `auto-detect sender=${senderId} sticker=${matchedSticker.fileUniqueId || 'unknown'}`);
        } catch (e) {
          api.logger.error(`[Stickers] Failed to detect sticker set from cache: ${e.message}`);
        }
      }, 2500);
    });
  }

  async function executeSelectSticker(rawInput) {
    const startedAt = Date.now();
    const queryText = normalizeWhitespace(rawInput);
    api.logger.info(`[Stickers] Intent search for: "${queryText}"`);

    try {
      const result = await searchSticker(queryText);
      if (result.shouldSend && result.sticker) {
        rememberSearchSelection(result.sticker, result.intentSummary);
      }
      api.logger.info(
        `[Stickers] Intent search for "${queryText}" took ${Date.now() - startedAt}ms `
        + `(shouldSend=${result.shouldSend}, confidence=${result.confidence.toFixed(3)}, reason=${result.reason}, `
        + `topScore=${result.topCandidate?.score?.toFixed?.(4) || 'n/a'})`
      );
      return { content: [{ type: 'text', text: buildToolResultText(result) }] };
    } catch (e) {
      api.logger.error(`[Stickers] Search error: ${e.message}`);
      return { content: [{ type: 'text', text: `搜索失败: ${e.message}` }] };
    }
  }

  api.registerTool({
    name: 'sync_sticker_set_by_name',
    emoji: '📥',
    description: '通过表情包合集的名字（或者包含名字的链接）来手动同步一个 Telegram 表情包合集。当用户发给你一个表情包链接，或者告诉你合集名字让你收集时调用。',
    parameters: {
      type: 'object',
      properties: {
        setNameOrUrl: {
          type: 'string',
          description: '合集的名字（例如：AnimalPack）或者合集的分享链接（例如：https://t.me/addstickers/AnimalPack）'
        }
      },
      required: ['setNameOrUrl']
    },
    async execute(id, params) {
      try {
        const targetSetName = normalizeSetName(params.setNameOrUrl);
        if (!targetSetName) {
          return { content: [{ type: 'text', text: '无法从你提供的参数中提取合集名称，请检查格式。' }] };
        }

        const queued = await queueSetOnce(targetSetName, 'manual-tool');
        if (!queued.queued) {
          if (queued.reason === 'already-synced') {
            return { content: [{ type: 'text', text: `表情包合集 ${targetSetName} 之前已经完整同步过了，这次不会重复同步，避免浪费资源。` }] };
          }
          return { content: [{ type: 'text', text: `表情包合集 ${targetSetName} 已经在同步队列里了。` }] };
        }

        return {
          content: [{
            type: 'text',
            text: `好的，我已经把合集 ${targetSetName} 加入同步队列了。同步期会继续使用 Gemini Embedding 2 建索引，聊天时只做本地轻量检索。`
          }]
        };
      } catch (e) {
        return { content: [{ type: 'text', text: `同步任务提交失败: ${e.message}` }] };
      }
    }
  });

  api.registerTool({
    name: 'get_sticker_stats',
    emoji: '📊',
    description: '查询当前表情包库中已处理和索引的表情包数量。当用户询问表情包库状态、进度时调用。',
    parameters: { type: 'object', properties: {} },
    async execute() {
      const indexedCount = getIndexedStickerCount();
      const completedSetCount = getCompletedSetCount();
      const queuedCount = syncQueue.length + (syncRunning ? 1 : 0);
      const autoCollectText = getAutoCollectEnabled() ? '开启' : '关闭';
      return {
        content: [{
          type: 'text',
          text: `当前语义索引中共有 ${indexedCount} 张表情包，已完整同步 ${completedSetCount} 个合集，当前同步队列中有 ${queuedCount} 个合集，自动收集目前为${autoCollectText}。`
        }]
      };
    }
  });

  api.registerTool({
    name: 'select_sticker_for_reply',
    emoji: '🎭',
    description: '根据最终回复文字和表达意图，为 Telegram 聊天选择更贴合情绪的贴纸。支持 should-send / skip 逻辑，不合适时会明确返回只发文字。',
    parameters: {
      type: 'object',
      properties: {
        replyText: {
          type: 'string',
          description: '你真正准备发出去的最终文字'
        },
        emotion: {
          anyOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }],
          description: '想表达的情绪，例如 开心、委屈、无奈、得意'
        },
        act: {
          anyOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }],
          description: '贴纸中的动作/姿态，例如 欢呼、瘫倒、抱抱、翻白眼'
        },
        intensity: {
          anyOf: [{ type: 'string' }, { type: 'number' }],
          description: '强度，可传 low/medium/high/max 或 0-1 数字'
        },
        context: {
          anyOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }],
          description: '语境或风格，例如 轻松收尾、撒娇、安慰、嘴硬'
        },
        query: {
          type: 'string',
          description: '可选补充提示词；一般只在 replyText 之外补几词，不要替代 replyText'
        },
        forbid: {
          type: 'string',
          description: '明确避免的风格或情绪，建议直接传一个字符串，例如 "阴阳怪气,攻击性太强"'
        },
        shouldSend: {
          type: 'boolean',
          description: '可选显式偏好：true=尽量发，false=本轮不发'
        },
        force: {
          type: 'boolean',
          description: '即使置信度一般也尽量给一个结果'
        }
      },
      required: ['replyText']
    },
    async execute(id, params) {
      return executeSelectSticker(JSON.stringify(params || {}));
    }
  });

  api.registerTool({
    name: 'search_sticker_by_emotion',
    emoji: '🔎',
    description: '通过语义搜索 Telegram 贴纸。兼容传统情绪关键词，也兼容直接传最终回复文本；更推荐传 JSON 字符串，把 replyText / emotion / act / intensity / forbid 一起给进去。',
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: '传统关键词，或 JSON 字符串，例如 {"replyText":"好耶终于下班啦","emotion":"开心 解脱","act":"欢呼"}'
        }
      },
      required: ['query']
    },
    async execute(id, params) {
      return executeSelectSticker(params.query);
    }
  });

  ensureIndexDb();
  importLegacySelectionStateIfNeeded();
  loadSearchCache();
};
