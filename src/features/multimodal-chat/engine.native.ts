/**
 * Native (iOS/Android) multimodal chat engine — module singleton shared by all hooks.
 * The ONLY place that imports react-native-nobodywho (its entry installs the native crate on import,
 * which would throw on web / static rendering — research A-4). Web resolves `engine.ts` (stub) instead.
 *
 * Library facts used here (react-native-nobodywho 4.0.0 source, checked 2026-10-01):
 * - downloadModel() returns the cached path immediately when the file exists (core huggingface.rs fetch_to_path).
 *   Cache key = <cache>/nobodywho/models/<owner>/<repo>/<file>; partial downloads are `<file>.<rand>.part` temp files.
 * - Model.load() downloads model and mmproj sequentially with separate progress callbacks, so we download
 *   each file explicitly first (clear per-file progress) and load from local paths (loadMs excludes download).
 * - new Chat() is synchronous and may throw "Not enough memory for context" (core memory.rs).
 * - Stream errors are thrown from nextToken(); stopGeneration() ends the stream normally.
 * - chat.ask() resets the worker's should_stop flag when the turn starts (core chat.rs), so a stop sent
 *   before generation actually begins is lost -> we re-send it from inside the stream loop.
 * - tokenize(text) may prepend BOS (core tokenizer.rs tokenize_text AddBos) -> subtract tokenize('') baseline.
 * - No delete API, no available-memory API, no perf stats API.
 */
import * as Device from 'expo-device';
import { Directory, File, Paths } from 'expo-file-system';
import { AppState } from 'react-native';

import {
  assessFit,
  CONTEXT_SIZE,
  DEFAULT_MAX_OUTPUT_TOKENS,
  getDeviceMemoryInfo,
  getModelInfo,
  MODEL_CATALOG,
} from './catalog';
import { prepareImage } from './image.native';
import type {
  ChatMessage,
  ContextUsage,
  DownloadFile,
  Engine,
  EngineSnapshot,
  LoadErrorCode,
  LoadState,
  ModelDownloadState,
  ModelEntry,
  ModelId,
  ModelInfo,
  ResponseMetrics,
  SendInput,
} from './types';
import type { NobodyWhoApi, NwChat, NwModel, NwPrompt } from './nobodywho-api';

// Typed through a local facade (see nobodywho-api.ts): importing the package's raw .ts sources
// makes `tsc --noEmit` fail inside node_modules (4.0.0 chat.ts tokenize type mismatch).
// eslint-disable-next-line @typescript-eslint/no-require-imports
const nobodywho = require('react-native-nobodywho') as NobodyWhoApi;
const { Chat, Model, Prompt, getCachedModels } = nobodywho;
const nwDownloadModel = nobodywho.downloadModel;

/** Qwen3/3.5 thinking off (docs: templateVariables). Unknown variables are ignored by other templates. */
const TEMPLATE_VARIABLES = { enable_thinking: false };
/** Minimal on purpose (no prompt tuning in this PoC). undefined = model template default. */
const SYSTEM_PROMPT: string | undefined = undefined;

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

const device = getDeviceMemoryInfo(Device.totalMemory);

const downloads: Record<ModelId, ModelDownloadState> = Object.fromEntries(
  MODEL_CATALOG.map((m) => [m.id, { status: 'notDownloaded', cachedBytes: 0 }]),
) as Record<ModelId, ModelDownloadState>;

let state: EngineSnapshot = {
  supported: true,
  device,
  models: [],
  loadState: { status: 'idle' },
  messages: [],
  isGenerating: false,
  isBusy: false,
  pendingModelId: null,
  contextUsage: null,
};
state = { ...state, models: buildModels(state.loadState) };

const listeners = new Set<() => void>();

let model: NwModel | null = null;
let chat: NwChat | null = null;
/** tokenize('') length for the current chat (BOS bias). */
let tokenizeBaseline = 0;

let generation: Promise<void> | null = null;
let stopRequested = false;

/** Serializes load/unload/reset. */
let opChain: Promise<void> = Promise.resolve();
let opPending = 0;
/** Bumped by every loadModel/unloadModel call: only the latest request is allowed to change the model. */
let loadSeq = 0;
/** loadSeq of an unload scheduled by the last release(); retain() cancels it while it is still the latest. */
let autoUnloadSeq: number | null = null;

let downloadChain: Promise<void> = Promise.resolve();
const pendingDownloads = new Map<ModelId, Promise<void>>();
/** Set when downloads changed and models[] must be rebuilt. */
let modelsDirty = false;

let holders = 0;
let releaseTimer: ReturnType<typeof setTimeout> | null = null;
let messageSeq = 0;

function activeModelId(loadState: LoadState): ModelId | null {
  switch (loadState.status) {
    case 'downloading':
    case 'loading':
    case 'ready':
      return loadState.modelId;
    default:
      return null;
  }
}

function buildModels(loadState: LoadState): ModelEntry[] {
  const active = activeModelId(loadState);
  return MODEL_CATALOG.map((info) => ({
    ...info,
    fit: assessFit(info, device),
    download: downloads[info.id],
    isActive: info.id === active,
  }));
}

/** models[] is rebuilt only when loadState or downloads changed (not on every streamed token). */
function setState(patch: Partial<EngineSnapshot>) {
  const next = { ...state, ...patch };
  if (modelsDirty || (patch.loadState !== undefined && patch.loadState !== state.loadState)) {
    next.models = buildModels(next.loadState);
    modelsDirty = false;
  }
  state = next;
  listeners.forEach((l) => l());
}

function setDownload(id: ModelId, next: ModelDownloadState) {
  downloads[id] = next;
  modelsDirty = true;
  setState({});
}

function updateMessage(id: string, patch: Partial<ChatMessage>) {
  setState({ messages: state.messages.map((m) => (m.id === id ? { ...m, ...patch } : m)) });
}

function nextMessageId(): string {
  messageSeq += 1;
  return `${Date.now().toString(36)}-${messageSeq}`;
}

function errorMessage(e: unknown): string {
  if (e instanceof Error) return e.message;
  return String(e);
}

function classifyError(e: unknown, fallback: LoadErrorCode): LoadErrorCode {
  const msg = errorMessage(e);
  if (/not enough memory|insufficient.?memory|out of memory/i.test(msg)) return 'insufficient_memory';
  return fallback;
}

function enqueueOp(op: () => Promise<void>): Promise<void> {
  opPending += 1;
  setState({ isBusy: true });
  const run = opChain.then(op).finally(() => {
    opPending -= 1;
    setState({ isBusy: opPending > 0 });
  });
  opChain = run.catch(() => undefined);
  return run;
}

// ---------------------------------------------------------------------------
// Cache / downloads
// ---------------------------------------------------------------------------

type CachedFile = { path: string; size: number };

/** "hf://owner/repo/file.gguf" -> ["owner", "repo", "file.gguf"] */
function hfParts(hfPath: string): [string, string, string] {
  const [owner, repo, ...rest] = hfPath.replace(/^hf:\/\//, '').split('/');
  return [owner, repo, rest.join('/')];
}

function cacheSuffix(hfPath: string): string {
  return `/${hfParts(hfPath).join('/')}`;
}

function listCached(): CachedFile[] {
  try {
    return getCachedModels().map((m) => ({ path: m.path, size: Number(m.size) }));
  } catch {
    return [];
  }
}

function findCached(cached: CachedFile[], hfPath: string) {
  const suffix = cacheSuffix(hfPath);
  return cached.find((c) => c.path.endsWith(suffix) && c.path.includes('/nobodywho/models/'));
}

function pathToFileUri(path: string): string {
  return `file://${encodeURI(path)}`;
}

function refreshDownloads() {
  const cached = listCached();
  for (const info of MODEL_CATALOG) {
    const current = downloads[info.id];
    if (current.status === 'queued' || current.status === 'downloading') continue;
    const m = findCached(cached, info.modelPath);
    const p = findCached(cached, info.projectionPath);
    if (m && p) {
      downloads[info.id] = { status: 'downloaded', sizeBytes: m.size + p.size };
    } else if (current.status !== 'error') {
      downloads[info.id] = { status: 'notDownloaded', cachedBytes: (m?.size ?? 0) + (p?.size ?? 0) };
    }
  }
  modelsDirty = true;
  setState({});
}

function reportProgress(info: ModelInfo, file: DownloadFile, downloaded: number, total: number) {
  const offset = file === 'projection' ? info.modelBytes : 0;
  const totalBytes =
    file === 'model'
      ? (total > 0 ? total : info.modelBytes) + info.projectionBytes
      : info.modelBytes + (total > 0 ? total : info.projectionBytes);
  const downloadedBytes = offset + downloaded;
  const progress = totalBytes > 0 ? Math.min(1, downloadedBytes / totalBytes) : 0;
  downloads[info.id] = { status: 'downloading', file, downloadedBytes, totalBytes, progress };
  modelsDirty = true;
  const ls = state.loadState;
  if (ls.status === 'downloading' && ls.modelId === info.id) {
    setState({ loadState: { status: 'downloading', modelId: info.id, downloadedBytes, totalBytes, progress } });
  } else {
    setState({});
  }
}

async function downloadFiles(info: ModelInfo): Promise<{ modelPath: string; projectionPath: string }> {
  const files: [DownloadFile, string][] = [
    ['model', info.modelPath],
    ['projection', info.projectionPath],
  ];
  const paths: Record<DownloadFile, string> = { model: '', projection: '' };
  for (const [file, hfPath] of files) {
    paths[file] = await nwDownloadModel({
      modelPath: hfPath,
      onDownloadProgress: (d, t) => reportProgress(info, file, d, t),
    });
  }
  return { modelPath: paths.model, projectionPath: paths.projection };
}

/** Throws on failure (internal). Downloads run one model at a time. */
function downloadInternal(id: ModelId): Promise<void> {
  if (downloads[id].status === 'downloaded') return Promise.resolve();
  const pending = pendingDownloads.get(id);
  if (pending) return pending;

  const info = getModelInfo(id);
  setDownload(id, { status: 'queued' });
  const run = downloadChain.then(async () => {
    try {
      reportProgress(info, 'model', 0, 0);
      await downloadFiles(info);
      downloads[id] = { status: 'notDownloaded', cachedBytes: 0 };
      refreshDownloads();
    } catch (e) {
      setDownload(id, { status: 'error', message: errorMessage(e) });
      throw e;
    } finally {
      pendingDownloads.delete(id);
    }
  });
  pendingDownloads.set(id, run);
  downloadChain = run.catch(() => undefined);
  return run;
}

async function downloadModel(id: ModelId): Promise<void> {
  try {
    await downloadInternal(id);
  } catch {
    // surfaced through models[].download = { status: 'error' }
  }
}

/** Cache directory of a model's HF repo (both files live in the same repo dir). */
function repoDirectory(info: ModelInfo, cached: CachedFile[]): Directory {
  const [owner, repo] = hfParts(info.modelPath);
  const marker = `/nobodywho/models/${owner}/${repo}/`;
  const hit = cached.find((c) => c.path.includes(marker));
  if (hit) {
    return new Directory(pathToFileUri(hit.path.slice(0, hit.path.indexOf(marker) + marker.length)));
  }
  const any = cached.find((c) => c.path.includes('/nobodywho/models/'));
  if (any) {
    const root = any.path.slice(0, any.path.indexOf('/nobodywho/models/') + '/nobodywho/models/'.length);
    return new Directory(pathToFileUri(`${root}${owner}/${repo}/`));
  }
  // dirs::cache_dir() on iOS = <container>/Library/Caches = expo Paths.cache.
  return new Directory(Paths.cache, 'nobodywho', 'models', owner, repo);
}

/**
 * Deletes the cached GGUF + mmproj files (and leftover `*.part` temp files) with expo-file-system.
 * Safe because nobodywho treats "file exists" as the only cache marker for GGUF (no index/manifest),
 * so a deleted file is simply downloaded again next time. Ignored while the model is loaded/loading/pending
 * (llama.cpp may mmap the weights) or while it is queued/downloading (the .part file is being written).
 */
async function deleteModel(id: ModelId): Promise<void> {
  if (activeModelId(state.loadState) === id || state.pendingModelId === id) return;
  const status = downloads[id].status;
  if (status === 'queued' || status === 'downloading') return;

  const info = getModelInfo(id);
  const cached = listCached();
  let failure: string | null = null;
  for (const hfPath of [info.modelPath, info.projectionPath]) {
    const entry = findCached(cached, hfPath);
    if (!entry) continue;
    try {
      const file = new File(pathToFileUri(entry.path));
      if (file.exists) file.delete();
    } catch (e) {
      failure = errorMessage(e);
    }
  }

  // Orphaned partial downloads (app killed mid-download): "<file>.<random>.part"
  try {
    const dir = repoDirectory(info, cached);
    if (dir.exists) {
      const prefixes = [info.modelPath, info.projectionPath].map((p) => `${hfParts(p)[2]}.`);
      for (const item of dir.list()) {
        if (item instanceof File && item.name.endsWith('.part') && prefixes.some((pre) => item.name.startsWith(pre))) {
          item.delete();
        }
      }
    }
  } catch (e) {
    failure = failure ?? errorMessage(e);
  }

  downloads[id] = failure
    ? { status: 'error', message: `삭제 실패: ${failure}` }
    : { status: 'notDownloaded', cachedBytes: 0 };
  refreshDownloads();
}

// ---------------------------------------------------------------------------
// Model lifecycle
// ---------------------------------------------------------------------------

async function stopAndWait() {
  if (generation) {
    stopRequested = true;
    try {
      chat?.stopGeneration();
    } catch {
      // ignore
    }
    await generation.catch(() => undefined);
  }
}

function safeDestroy(target: { destroy(): void } | null) {
  try {
    target?.destroy();
  } catch {
    // already destroyed
  }
}

function teardown() {
  safeDestroy(chat);
  safeDestroy(model);
  chat = null;
  model = null;
  tokenizeBaseline = 0;
}

/**
 * Latest request wins: every call bumps loadSeq, and the op bails out after each await if a newer
 * loadModel/unloadModel was issued (a Model that finished loading in the meantime is destroyed).
 * Download runs outside the op queue and before teardown, so the current model stays loaded and usable
 * while another model downloads, and stays loaded if that download fails.
 */
async function loadModel(id: ModelId): Promise<void> {
  const mySeq = ++loadSeq;
  const isStale = () => mySeq !== loadSeq;

  refreshDownloads();
  if (state.loadState.status === 'ready' && state.loadState.modelId === id && chat) {
    setState({ pendingModelId: null });
    return;
  }
  const info = getModelInfo(id);
  setState({ pendingModelId: id });

  if (downloads[id].status !== 'downloaded') {
    if (state.loadState.status !== 'ready') {
      setState({
        loadState: { status: 'downloading', modelId: id, downloadedBytes: 0, totalBytes: info.downloadBytes, progress: 0 },
      });
    }
    try {
      await downloadInternal(id);
    } catch (e) {
      if (isStale()) return;
      refreshDownloads();
      setState({
        pendingModelId: null,
        // Keep a ready model as-is; the failure is visible in models[].download.
        ...(state.loadState.status === 'ready'
          ? {}
          : { loadState: { status: 'error', modelId: id, code: 'download_failed', message: errorMessage(e) } }),
      });
      return;
    }
    if (isStale()) return;
  }

  await enqueueOp(async () => {
    if (isStale()) return;
    await stopAndWait();
    if (isStale()) return;

    teardown();
    setState({ loadState: { status: 'loading', modelId: id }, messages: [], contextUsage: null, isGenerating: false });

    let loaded: NwModel | null = null;
    let created: NwChat | null = null;
    try {
      // Cache hit -> returns local paths without network. Re-downloads if the OS purged the cache meanwhile.
      const paths = await downloadFiles(info);
      if (isStale()) return;
      const started = performance.now();
      loaded = await Model.load({ modelPath: paths.modelPath, projectionModelPath: paths.projectionPath, useGpu: true });
      if (isStale()) {
        safeDestroy(loaded);
        return;
      }
      created = new Chat({
        model: loaded,
        systemPrompt: SYSTEM_PROMPT,
        contextSize: CONTEXT_SIZE,
        templateVariables: TEMPLATE_VARIABLES,
      });
      const loadMs = performance.now() - started;
      const stats = await created.getStats();
      const baseline = (await created.tokenize('')).length;
      if (isStale()) {
        safeDestroy(created);
        safeDestroy(loaded);
        return;
      }
      model = loaded;
      chat = created;
      tokenizeBaseline = baseline;
      setState({
        loadState: { status: 'ready', modelId: id, loadMs, contextSize: stats.contextSize },
        pendingModelId: null,
        contextUsage: { used: stats.contextUsed, size: stats.contextSize },
      });
    } catch (e) {
      safeDestroy(created);
      safeDestroy(loaded);
      if (isStale()) return;
      teardown();
      setState({
        loadState: { status: 'error', modelId: id, code: classifyError(e, 'load_failed'), message: errorMessage(e) },
        pendingModelId: null,
      });
    } finally {
      refreshDownloads();
    }
  });
}

function unloadModel(): Promise<void> {
  const mySeq = ++loadSeq;
  return enqueueOp(async () => {
    if (mySeq !== loadSeq) return;
    await stopAndWait();
    if (mySeq !== loadSeq) return;
    teardown();
    setState({
      loadState: { status: 'idle' },
      pendingModelId: null,
      messages: [],
      contextUsage: null,
      isGenerating: false,
    });
  });
}

// ---------------------------------------------------------------------------
// Chat
// ---------------------------------------------------------------------------

async function countTokens(activeChat: NwChat, text: string): Promise<number> {
  if (!text) return 0;
  return Math.max(0, (await activeChat.tokenize(text)).length - tokenizeBaseline);
}

async function runGeneration(activeChat: NwChat, modelId: ModelId, input: SendInput) {
  const text = input.text.trim();
  const maxOutputTokens = Math.max(1, Math.floor(input.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS));
  const userMsg: ChatMessage = { id: nextMessageId(), role: 'user', text, imageUri: input.imageUri };
  const assistantId = nextMessageId();
  const assistantMsg: ChatMessage = { id: assistantId, role: 'assistant', text: '', status: 'streaming' };
  setState({ messages: [...state.messages, userMsg, assistantMsg], isGenerating: true });

  let acc = '';
  try {
    let prompt: string | NwPrompt = text;
    let imagePrepMs: number | undefined;
    if (input.imageUri) {
      const prepared = await prepareImage(input.imageUri);
      imagePrepMs = prepared.prepMs;
      prompt = new Prompt(text ? [Prompt.Image(prepared.path), Prompt.Text(text)] : [Prompt.Image(prepared.path)]);
    }
    if (stopRequested) {
      updateMessage(assistantId, { status: 'stopped' });
      return;
    }

    const before = await activeChat.getStats();
    if (stopRequested) {
      updateMessage(assistantId, { status: 'stopped' });
      return;
    }

    const started = performance.now();
    let firstAt: number | null = null;
    let lastAt = started;
    let events = 0;
    let stopSent = false;
    let hitTokenCap = false;
    // Never `break`: the stream is always consumed to its natural end so the chat worker finishes the turn.
    for await (const token of activeChat.ask(prompt)) {
      const now = performance.now();
      if (firstAt === null && token.length > 0) firstAt = now;
      lastAt = now;
      acc += token;
      events += 1;
      if (!stopSent && events >= maxOutputTokens && !stopRequested) {
        hitTokenCap = true;
        activeChat.stopGeneration();
        stopSent = true;
      }
      // ask() resets should_stop at turn start, so a stop() issued before that is re-sent here.
      if (stopRequested && !stopSent) {
        activeChat.stopGeneration();
        stopSent = true;
      }
      updateMessage(assistantId, { text: acc });
    }
    const endedAt = performance.now();

    const after = await activeChat.getStats();
    const outputTokens = await countTokens(activeChat, acc);
    let imageTokens: number | undefined;
    if (typeof prompt !== 'string') {
      try {
        imageTokens = (await activeChat.tokenize(prompt)).filter((t) => t == null).length;
      } catch {
        imageTokens = undefined;
      }
    }
    const delta = after.contextUsed - before.contextUsed;
    const firstTokenAt = firstAt ?? endedAt;
    const decodeMs = Math.max(0, lastAt - firstTokenAt);
    const userStopped = stopRequested && !hitTokenCap;
    const metrics: ResponseMetrics = {
      ttftMs: firstTokenAt - started,
      totalMs: endedAt - started,
      decodeMs,
      outputTokens,
      tokensPerSec: outputTokens > 1 && decodeMs > 0 ? ((outputTokens - 1) / decodeMs) * 1000 : 0,
      promptTokens: delta >= outputTokens ? delta - outputTokens : undefined,
      imageTokens,
      imagePrepMs,
      contextUsed: after.contextUsed,
      stopped: userStopped,
      hitTokenCap,
      maxOutputTokens,
      modelId,
    };
    updateMessage(assistantId, { status: userStopped ? 'stopped' : 'done', metrics });
    setState({ contextUsage: { used: after.contextUsed, size: after.contextSize } });
  } catch (e) {
    updateMessage(assistantId, { status: 'error', error: errorMessage(e), text: acc });
  }
}

async function send(input: SendInput): Promise<void> {
  const ls = state.loadState;
  if (ls.status !== 'ready' || !chat || generation) return;
  // A load/unload/reset is queued or running: it would destroy or reset this chat mid-turn.
  if (opPending > 0) return;
  if (!input.text.trim() && !input.imageUri) return;

  stopRequested = false;
  const run = runGeneration(chat, ls.modelId, input);
  generation = run;
  try {
    await run;
  } finally {
    generation = null;
    stopRequested = false;
    setState({ isGenerating: false });
  }
}

function stop() {
  if (!generation) return;
  stopRequested = true;
  try {
    chat?.stopGeneration();
  } catch {
    // ignore
  }
}

function reset(): Promise<void> {
  return enqueueOp(async () => {
    await stopAndWait();
    let contextUsage: ContextUsage | null = null;
    if (chat) {
      try {
        await chat.resetHistory();
        const stats = await chat.getStats();
        contextUsage = { used: stats.contextUsed, size: stats.contextSize };
      } catch {
        contextUsage = state.contextUsage;
      }
    }
    setState({ messages: [], contextUsage });
  });
}

// iOS forbids Metal command submission in the background -> stop generating when the app is backgrounded.
AppState.addEventListener('change', (next) => {
  if (next === 'background') stop();
});

// ---------------------------------------------------------------------------
// Lifetime
// ---------------------------------------------------------------------------

function retain(): () => void {
  holders += 1;
  if (releaseTimer) {
    clearTimeout(releaseTimer);
    releaseTimer = null;
  }
  // An auto-unload already queued (screen left and re-entered quickly) is cancelled while it is still
  // the latest request. Bumping loadSeq makes its op bail out.
  if (autoUnloadSeq !== null && autoUnloadSeq === loadSeq) {
    loadSeq += 1;
  }
  autoUnloadSeq = null;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    holders -= 1;
    if (holders > 0) return;
    // Deferred so StrictMode / fast-refresh remounts do not unload the model.
    releaseTimer = setTimeout(() => {
      releaseTimer = null;
      if (holders !== 0) return;
      void unloadModel();
      autoUnloadSeq = loadSeq;
    }, 0);
  };
}

export const engine: Engine = {
  subscribe(listener) {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },
  getSnapshot: () => state,
  retain,
  refreshDownloads,
  downloadModel,
  deleteModel,
  loadModel,
  unloadModel,
  send,
  stop,
  reset,
};
