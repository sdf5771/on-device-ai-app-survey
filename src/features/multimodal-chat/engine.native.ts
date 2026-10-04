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
 *
 * Context accounting (agent-log BUG-2/BUG-3, react-native-nobodywho 4.0.0 + llama.cpp mtmd, checked 2026-10-04):
 * - getStats().contextUsed = InferenceEngine.n_past = llama.cpp POSITION counter, not KV cells.
 *   For M-RoPE vision models (Qwen-VL family incl. Qwen3.5) mtmd advances n_past by max(grid_w, grid_h) per image
 *   (mtmd_image_tokens_get_n_pos) while the image takes grid_w*grid_h KV cells -> an image is ~95% invisible.
 *   -> we track those hidden cells per image turn (hiddenImageCells) and report used = positions + hidden.
 * - nobodywho's own context shift / KV trimming compares token indices (chunk n_tokens, images counted in full)
 *   with n_past (positions) -> with an M-RoPE image in the KV it neither trims the KV nor re-reads the prompt
 *   correctly. So when images are involved the engine never lets a turn reach the shift: send() refuses with
 *   errorCode 'context_full' if used + prompt + maxOutputTokens + margin > contextSize.
 * - resetHistory() only clears messages; the KV / n_past are trimmed lazily on the next ask -> reset() uses
 *   resetContext() (core reset_chat: clears KV, n_past = 0, KV mirror), so getStats() is 0 right after reset.
 */
import * as Device from 'expo-device';
import { Directory, File, Paths } from 'expo-file-system';
import { AppState } from 'react-native';

import {
  assessFit,
  CONTEXT_SAFETY_MARGIN,
  CONTEXT_SIZE,
  CONTEXT_TEMPLATE_MARGIN,
  DEFAULT_MAX_OUTPUT_TOKENS,
  getDeviceMemoryInfo,
  getModelInfo,
  MODEL_CATALOG,
  REREAD_TEMPLATE_TOKENS,
} from './catalog';
import { prepareImage } from './image.native';
import type {
  ChatMessage,
  ContextCheck,
  ContextUsage,
  DownloadFile,
  ImagePositionMode,
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
import type { NobodyWhoApi, NwChat, NwChatStats, NwModel, NwPrompt } from './nobodywho-api';

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
/**
 * KV cells occupied by images in the current context that getStats().contextUsed (positions) does not count.
 * Reset to 0 with the KV cache (reset/load/unload). See the header comment.
 */
let hiddenImageCells = 0;
/** true when hiddenImageCells is uncertain (fallback estimate, or a turn with images failed mid-way). */
let usageEstimated = false;
/**
 * How llama.cpp positions advance for an image with the loaded model. Set from the catalog on load
 * (ModelInfo.positionMode); 'unknown' is resolved by runtime detection on the first image turn.
 */
let imagePositionMode: ImagePositionMode = 'unknown';
/** The catalog value was confirmed/contradicted by a runtime check already (check once per load). */
let positionModeChecked = false;
/**
 * Output tokens of the last completed answer. While hiddenImageCells > 0 nobodywho re-reads this answer into the KV
 * on the next turn (it cannot trim it, see header) -> reserved by the context guard. 0 after reset/load.
 */
let lastAnswerTokens = 0;

let generation: Promise<void> | null = null;
let stopRequested = false;

/** Serializes load/unload/reset. */
let opChain: Promise<void> = Promise.resolve();
let opPending = 0;
/** Bumped by every loadModel/unloadModel call: only the latest request is allowed to change the model. */
let loadSeq = 0;

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
  resetContextAccounting();
  imagePositionMode = 'unknown';
  positionModeChecked = false;
}

/** KV is empty again (reset / new chat): forget everything derived from the old KV contents. */
function resetContextAccounting() {
  hiddenImageCells = 0;
  usageEstimated = false;
  lastAnswerTokens = 0;
}

function toUsage(stats: NwChatStats): ContextUsage {
  return {
    used: stats.contextUsed + hiddenImageCells,
    size: stats.contextSize,
    positionsUsed: stats.contextUsed,
    hiddenImageCells,
    estimated: usageEstimated,
  };
}

/** The latest loadModel request (for de-duplicating repeated calls). null after an unload request. */
let latestLoad: { id: ModelId; seq: number } | null = null;

/**
 * Makes sure both files of `id` are cached, through the shared download queue.
 * Returns false when the request went stale or the download failed. On failure (and only when this request is
 * still the latest) it finalizes state itself: a ready model is kept, otherwise loadState becomes download_failed.
 */
async function ensureDownloaded(id: ModelId, isStale: () => boolean): Promise<boolean> {
  refreshDownloads();
  if (downloads[id].status === 'downloaded') return true;
  const info = getModelInfo(id);
  if (state.loadState.status !== 'ready') {
    setState({
      loadState: { status: 'downloading', modelId: id, downloadedBytes: 0, totalBytes: info.downloadBytes, progress: 0 },
    });
  }
  try {
    await downloadInternal(id);
  } catch (e) {
    if (isStale()) return false;
    refreshDownloads();
    setState({
      pendingModelId: null,
      // Keep a ready model as-is; the failure is visible in models[].download.
      ...(state.loadState.status === 'ready'
        ? {}
        : { loadState: { status: 'error', modelId: id, code: 'download_failed', message: errorMessage(e) } }),
    });
    return false;
  }
  return !isStale();
}

/** A direct downloadFiles() call (outside downloadInternal) can leave downloads[id] at 'downloading'. */
function settleDirectDownloadState(id: ModelId) {
  if (downloads[id].status === 'downloading' && !pendingDownloads.has(id)) {
    downloads[id] = { status: 'notDownloaded', cachedBytes: 0 };
  }
  refreshDownloads();
}

/**
 * Latest request wins. Every loadModel/unloadModel request bumps loadSeq, and an op bails out after each await
 * if a newer request exists (a Model/Chat that finished in the meantime is destroyed).
 *
 * Invariant: loadSeq is bumped ONLY by a request that will itself finalize loadState/pendingModelId
 * (loadModel, unloadModel, or the auto-unload at the moment it actually runs). Therefore every stale
 * return below is covered by a newer request that sets the final state. Stale paths:
 *  - download phase (ensureDownloaded) -> newer request finalizes
 *  - op start / after stopAndWait -> nothing changed yet, newer request finalizes
 *  - after teardown (loadState 'loading') -> newer load sets its own loadState, newer unload sets idle
 * Exceptions that do not bump: de-duplicated repeat loadModel(id) (no-op, the in-flight request stays latest).
 *
 * Download runs before teardown, so the current model stays loaded and usable while another model downloads,
 * and stays loaded if that download fails.
 */
async function loadModel(id: ModelId): Promise<void> {
  const ls = state.loadState;
  // De-dup: the latest request is already a load of `id` that is downloading/loading.
  if (
    latestLoad &&
    latestLoad.id === id &&
    latestLoad.seq === loadSeq &&
    state.pendingModelId === id &&
    (ls.status === 'ready' ? ls.modelId !== id : true)
  ) {
    return;
  }

  const mySeq = ++loadSeq;
  latestLoad = { id, seq: mySeq };
  const isStale = () => mySeq !== loadSeq;

  if (ls.status === 'ready' && ls.modelId === id && chat) {
    setState({ pendingModelId: null });
    return;
  }
  const info = getModelInfo(id);
  setState({ pendingModelId: id });

  if (!(await ensureDownloaded(id, isStale))) return;

  await enqueueOp(async () => {
    if (isStale()) return;
    await stopAndWait();
    if (isStale()) return;
    // The OS may have purged Library/Caches since the first check: re-download through the queue
    // while the current model is still loaded.
    if (!(await ensureDownloaded(id, isStale))) return;

    teardown();
    setState({ loadState: { status: 'loading', modelId: id }, messages: [], contextUsage: null, isGenerating: false });

    let loaded: NwModel | null = null;
    let created: NwChat | null = null;
    let phase: LoadErrorCode = 'download_failed';
    try {
      // Cache hit -> local paths, no network, no progress callbacks.
      const paths = await downloadFiles(info);
      if (isStale()) return;
      phase = 'load_failed';
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
      imagePositionMode = info.positionMode;
      positionModeChecked = false;
      setState({
        loadState: { status: 'ready', modelId: id, loadMs, contextSize: stats.contextSize },
        pendingModelId: null,
        contextUsage: toUsage(stats),
      });
    } catch (e) {
      safeDestroy(created);
      safeDestroy(loaded);
      if (isStale()) return;
      teardown();
      setState({
        loadState: { status: 'error', modelId: id, code: classifyError(e, phase), message: errorMessage(e) },
        pendingModelId: null,
      });
    } finally {
      settleDirectDownloadState(id);
    }
  });
}

async function unloadOp(mySeq: number) {
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
}

function unloadModel(): Promise<void> {
  const mySeq = ++loadSeq;
  latestLoad = null;
  return enqueueOp(() => unloadOp(mySeq));
}

/**
 * Unload requested by the last hook unmounting. It does NOT bump loadSeq when queued: it decides when it
 * actually runs. If a hook re-mounted meanwhile (holders > 0) it is skipped and nothing becomes stale;
 * otherwise it becomes the latest request at that moment and finalizes state (idle).
 */
function autoUnload(): Promise<void> {
  return enqueueOp(async () => {
    if (holders > 0) return;
    const mySeq = ++loadSeq;
    latestLoad = null;
    await unloadOp(mySeq);
  });
}

// ---------------------------------------------------------------------------
// Chat
// ---------------------------------------------------------------------------

async function countTokens(activeChat: NwChat, text: string): Promise<number> {
  if (!text) return 0;
  return Math.max(0, (await activeChat.tokenize(text)).length - tokenizeBaseline);
}

type PromptCost = { textTokens: number; imageTokens: number };

/**
 * KV cost of the user content, without chat template. tokenize(Prompt) loads + preprocesses the image
 * (mtmd tokenize, no vision encoding). Image slots (incl. mtmd's wrapper tokens such as <|vision_start|>) are null.
 */
async function promptCost(activeChat: NwChat, prompt: string | NwPrompt): Promise<PromptCost> {
  const ids = await activeChat.tokenize(prompt);
  let imageTokens = 0;
  for (const t of ids) if (t == null) imageTokens += 1;
  return { textTokens: Math.max(0, ids.length - imageTokens - tokenizeBaseline), imageTokens };
}

/**
 * Runtime cross-check of the image position mode on a completed image turn.
 * Linear lower bound: with linear positions the prompt advances by at least textTokens + imageTokens
 * (+ chat template). Fewer positions than that can only mean the image advanced by less than its token count -> mrope.
 * Only trusted while hiddenImageCells == 0 (afterwards nobodywho re-reads the previous answer every turn, which
 * inflates promptPositions). Catalog value wins; a mismatch is logged for investigation.
 */
function crossCheckPositionMode(promptPositions: number, textTokens: number, imageTokens: number) {
  if (positionModeChecked || hiddenImageCells > 0 || promptPositions <= 0 || imageTokens <= 0) return;
  positionModeChecked = true;
  const detected: ImagePositionMode = promptPositions < textTokens + imageTokens ? 'mrope' : 'linear';
  if (imagePositionMode === 'unknown') {
    imagePositionMode = detected;
  } else if (imagePositionMode !== detected) {
    console.warn(
      `[multimodal-chat] image position mode mismatch: catalog=${imagePositionMode} detected=${detected} ` +
        `(promptPositions=${promptPositions}, textTokens=${textTokens}, imageTokens=${imageTokens}). Using catalog.`,
    );
  }
}

/**
 * KV cells of ONE image that the position counter did not advance for.
 * Invariant: exactly one image per turn (SendInput has a single imageUri). With several images in a prompt the
 * sqrt estimate below would have to be applied per image with each image's own size.
 * - linear: 0.
 * - mrope: positions advanced by ~max(grid_w, grid_h); long grid side ~ sqrt(n * aspect)
 *   (mtmd: n = grid_w * grid_h, plus a couple of wrapper tokens like <|vision_start|>). Error: a few cells per image.
 * - unknown (not resolved): whole image counted (over-estimate by ~max(grid) -> safe side), exact = false.
 */
function hiddenCellsForImage(imageTokens: number, width: number, height: number): { hidden: number; exact: boolean } {
  if (imageTokens <= 0 || imagePositionMode === 'linear') return { hidden: 0, exact: true };
  const aspect = width > 0 && height > 0 ? Math.max(width, height) / Math.min(width, height) : 0;
  if (imagePositionMode === 'unknown' || !Number.isFinite(aspect) || aspect <= 0) {
    return { hidden: imageTokens, exact: false };
  }
  const imagePositions = Math.round(Math.sqrt(imageTokens * aspect));
  return { hidden: Math.max(0, imageTokens - imagePositions), exact: true };
}

/**
 * Cells nobodywho will append on the next turn ON TOP of the new prompt, because it cannot trim the previous answer.
 *
 * Mechanism (core inference.rs sync_context, 4.0.0): the re-rendered history differs from the KV mirror inside the
 * previous assistant turn (Qwen template drops the `<think></think>` block from past turns). That diff index is in
 * TOKEN space (images counted in full) and is compared with n_past (POSITION space):
 * - previous answer shorter than the hidden image cells -> n_past <= index -> early return, nothing trimmed, the
 *   answer is appended again: +answer +~4 cells (measured: 13-token answer -> +17).
 * - longer answer -> n_past > index -> seq_rm; Qwen3.5 is hybrid (recurrent layers) so partial removal fails and
 *   nobodywho resets the KV and re-reads the whole history (no extra cells, but image re-encoding in TTFT;
 *   measured: 701/776-token answers -> +0 cells, text-turn TTFT ~36 s on the simulator CPU).
 * The boundary is fuzzy by a few tokens (template), so a band of REREAD_TEMPLATE_TOKENS * 2 is reserved as "re-read".
 * Assumption: every 'mrope' model in the catalog is Qwen3.5 (hybrid). A non-hybrid M-RoPE model would take a
 * partial seq_rm at a token-space index instead (different, also broken, behaviour) -> re-check before adding one.
 */
function expectedRereadTokens(): number {
  if (hiddenImageCells <= 0 || lastAnswerTokens <= 0) return 0;
  const reread = lastAnswerTokens + REREAD_TEMPLATE_TOKENS;
  return reread <= hiddenImageCells + REREAD_TEMPLATE_TOKENS * 2 ? reread : 0;
}

function contextGuardNeeded(hasImage: boolean): boolean {
  // Text-only context: positions == KV cells, so nobodywho's own context shift works -> leave it alone.
  return hasImage || hiddenImageCells > 0;
}

async function runGeneration(activeChat: NwChat, modelId: ModelId, input: SendInput) {
  const text = input.text.trim();
  const maxOutputTokens = Math.max(1, Math.floor(input.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS));
  const userMsg: ChatMessage = { id: nextMessageId(), role: 'user', text, imageUri: input.imageUri };
  const assistantId = nextMessageId();
  const assistantMsg: ChatMessage = { id: assistantId, role: 'assistant', text: '', status: 'streaming' };
  setState({ messages: [...state.messages, userMsg, assistantMsg], isGenerating: true });

  let acc = '';
  let askStarted = false;
  /** Image tokens of this turn not yet accounted in hiddenImageCells (for the error path). */
  let pendingImageCells = 0;
  try {
    let prompt: string | NwPrompt = text;
    let imagePrepMs: number | undefined;
    let imageSize = { width: 0, height: 0 };
    if (input.imageUri) {
      const prepared = await prepareImage(input.imageUri);
      imagePrepMs = prepared.prepMs;
      imageSize = { width: prepared.width, height: prepared.height };
      prompt = new Prompt(text ? [Prompt.Image(prepared.path), Prompt.Text(text)] : [Prompt.Image(prepared.path)]);
    }
    if (stopRequested) {
      updateMessage(assistantId, { status: 'stopped' });
      return;
    }

    const before = await activeChat.getStats();
    const cost = await promptCost(activeChat, prompt);
    const imageTokens = typeof prompt !== 'string' ? cost.imageTokens : undefined;
    if (stopRequested) {
      updateMessage(assistantId, { status: 'stopped' });
      return;
    }

    // Deterministic refusal instead of letting nobodywho reach its (image-unsafe) context shift / KV overflow.
    if (contextGuardNeeded(typeof prompt !== 'string')) {
      const used = before.contextUsed + hiddenImageCells;
      const promptTokens = cost.textTokens + cost.imageTokens + CONTEXT_TEMPLATE_MARGIN;
      const rereadTokens = expectedRereadTokens();
      const required = used + promptTokens + rereadTokens + maxOutputTokens + CONTEXT_SAFETY_MARGIN;
      if (required > before.contextSize) {
        const check: ContextCheck = {
          used,
          promptTokens,
          maxOutputTokens,
          margin: CONTEXT_SAFETY_MARGIN,
          rereadTokens,
          required,
          size: before.contextSize,
        };
        updateMessage(userMsg.id, { notSent: true });
        updateMessage(assistantId, {
          status: 'error',
          errorCode: 'context_full',
          contextCheck: check,
          error: `컨텍스트 부족: 필요 ${required} / ${before.contextSize} 토큰. 대화를 초기화하세요.`,
        });
        setState({ contextUsage: toUsage(before) });
        return;
      }
    }

    pendingImageCells = cost.imageTokens;

    const started = performance.now();
    let firstAt: number | null = null;
    let lastAt = started;
    let events = 0;
    let stopSent = false;
    let hitTokenCap = false;
    // Never `break`: the stream is always consumed to its natural end so the chat worker finishes the turn.
    askStarted = true;
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
    const positionsDelta = after.contextUsed - before.contextUsed;
    let hiddenThisTurn = 0;
    if (imageTokens) {
      if (positionsDelta >= 0) crossCheckPositionMode(positionsDelta - outputTokens, cost.textTokens, imageTokens);
      if (imagePositionMode === 'linear') {
        hiddenThisTurn = 0;
      } else if (positionsDelta < 0) {
        // The library shifted/reset its KV during this turn (should not happen behind the guard): unknown state.
        hiddenThisTurn = imageTokens;
        usageEstimated = true;
      } else {
        const r = hiddenCellsForImage(imageTokens, imageSize.width, imageSize.height);
        hiddenThisTurn = r.hidden;
        if (!r.exact) usageEstimated = true;
      }
      hiddenImageCells += hiddenThisTurn;
    }
    pendingImageCells = 0;
    lastAnswerTokens = outputTokens;
    const delta = positionsDelta + hiddenThisTurn;
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
      contextUsed: after.contextUsed + hiddenImageCells,
      stopped: userStopped,
      hitTokenCap,
      maxOutputTokens,
      modelId,
    };
    updateMessage(assistantId, { status: userStopped ? 'stopped' : 'done', metrics });
    setState({ contextUsage: toUsage(after) });
  } catch (e) {
    updateMessage(assistantId, { status: 'error', errorCode: 'generation_failed', error: errorMessage(e), text: acc });
    if (askStarted && pendingImageCells > 0 && imagePositionMode !== 'linear') {
      // The image stays in the library's history (it is re-read on the next turn) but how much of it is in the
      // KV now is unknown -> count it in full and flag the gauge as an estimate until reset().
      hiddenImageCells += pendingImageCells;
      usageEstimated = true;
    }
    // Partial answer may or may not be in the library history: reserve what was streamed (safe side).
    if (askStarted && acc) lastAnswerTokens = await countTokens(activeChat, acc).catch(() => lastAnswerTokens);
    try {
      setState({ contextUsage: toUsage(await activeChat.getStats()) });
    } catch {
      // keep the previous usage
    }
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
        // resetContext (not resetHistory): clears the KV cache and n_past now, so getStats() is ~0 right away.
        // resetHistory only clears messages and leaves the KV to be trimmed on the next ask (BUG-2).
        await chat.resetContext({ systemPrompt: SYSTEM_PROMPT });
        resetContextAccounting();
      } catch {
        // resetContext failed: the KV is unchanged -> keep the previous usage.
        setState({ messages: [], contextUsage: state.contextUsage });
        return;
      }
      try {
        contextUsage = toUsage(await chat.getStats());
      } catch {
        // resetContext succeeded, so the KV is empty even if the stats query failed.
        const size = state.contextUsage?.size ?? CONTEXT_SIZE;
        contextUsage = { used: 0, size, positionsUsed: 0, hiddenImageCells: 0, estimated: false };
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
  let released = false;
  return () => {
    if (released) return;
    released = true;
    holders -= 1;
    if (holders > 0) return;
    // Deferred so StrictMode / fast-refresh remounts do not even queue an unload.
    // An unload that is already queued re-checks holders when it runs (autoUnload).
    releaseTimer = setTimeout(() => {
      releaseTimer = null;
      if (holders === 0) void autoUnload();
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
