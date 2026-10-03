/**
 * Public types for the multimodal chat inference layer.
 * Contract: agent-log/interfaces.md (ai-engineer <-> frontend).
 * This file must stay free of native imports (it is shared with the web stub).
 */

export type ModelId = 'qwen3.5-0.8b' | 'qwen3.5-2b' | 'qwen3.5-4b' | 'gemma4-e2b';

export type ModelInfo = {
  id: ModelId;
  /** Display name, e.g. "Qwen3.5 2B". */
  name: string;
  /** Short Korean description for the model list. */
  description: string;
  quantization: string;
  /** hf:// path of the language model GGUF. */
  modelPath: string;
  /** hf:// path of the vision projector (mmproj) GGUF. */
  projectionPath: string;
  /** Bytes of the GGUF file (Hugging Face API, 2026-10-01). */
  modelBytes: number;
  /** Bytes of the mmproj file (Hugging Face API, 2026-10-01). */
  projectionBytes: number;
  /** modelBytes + projectionBytes. Download size. */
  downloadBytes: number;
  /** Estimated peak resident memory when loaded (weights + mmproj + KV@4096 + runtime). Estimate, not measured. */
  estimatedMemoryBytes: number;
  license: string;
};

/**
 * - recommended: fits comfortably in the estimated safe budget for this device
 * - borderline: may work, OOM/jetsam possible (research C-3)
 * - notRecommended: likely to be killed; still selectable for experiments
 * - unknown: device memory not available (web, or expo-device returned null)
 */
export type ModelFit = 'recommended' | 'borderline' | 'notRecommended' | 'unknown';

export type DeviceMemoryInfo = {
  /** expo-device Device.totalMemory (physical RAM). null when unavailable. */
  totalMemoryBytes: number | null;
  /** Estimated safe budget for model + KV + runtime (see catalog.ts thresholds). */
  recommendedBudgetBytes: number | null;
  /** Estimated upper bound before iOS jetsam (see catalog.ts thresholds). */
  borderlineBudgetBytes: number | null;
};

export type DownloadFile = 'model' | 'projection';

export type ModelDownloadState =
  | { status: 'notDownloaded'; /** bytes of files already cached (e.g. only GGUF, no mmproj) */ cachedBytes: number }
  | { status: 'queued' }
  | {
      status: 'downloading';
      /** Which of the two files is downloading right now (GGUF first, then mmproj). */
      file: DownloadFile;
      /** Overall bytes across both files (approximate total from the catalog). */
      downloadedBytes: number;
      totalBytes: number;
      /** 0..1 overall progress. */
      progress: number;
    }
  | { status: 'downloaded'; sizeBytes: number }
  | { status: 'error'; message: string };

export type ModelEntry = ModelInfo & {
  fit: ModelFit;
  download: ModelDownloadState;
  /** true when this model is currently loaded (or loading) in memory. */
  isActive: boolean;
};

export type LoadErrorCode =
  | 'insufficient_memory'
  | 'download_failed'
  | 'load_failed'
  | 'unknown';

export type LoadState =
  | { status: 'idle' }
  | { status: 'downloading'; modelId: ModelId; downloadedBytes: number; totalBytes: number; progress: number }
  | { status: 'loading'; modelId: ModelId }
  | { status: 'ready'; modelId: ModelId; loadMs: number; contextSize: number }
  | { status: 'unsupported' }
  | { status: 'error'; modelId: ModelId | null; code: LoadErrorCode; message: string };

export type ResponseMetrics = {
  /** ask() call -> first non-empty token (ms). Includes image encoding + prefill + JSI overhead. */
  ttftMs: number;
  /** ask() call -> stream end (ms). */
  totalMs: number;
  /** first token -> last token (ms). */
  decodeMs: number;
  /** Output tokens counted with chat.tokenize(responseText) minus the tokenize('') baseline (BOS), not stream event count. */
  outputTokens: number;
  /** Decode speed: (outputTokens - 1) / decodeMs * 1000. 0 when < 2 tokens. */
  tokensPerSec: number;
  /**
   * KV cells used by the prompt (chat template + text + every image token) =
   * true context delta (positions delta + image cells hidden from positions, see ContextUsage) - outputTokens.
   * Undefined if a context shift happened (delta smaller than outputTokens).
   */
  promptTokens?: number;
  /** Image embedding slots in the prompt (null entries from chat.tokenize(prompt)). Only when an image was sent. */
  imageTokens?: number;
  /** Image preprocessing (resize + JPEG) time (ms). Not included in ttftMs. */
  imagePrepMs?: number;
  /** Context usage after this response = ContextUsage.used (true KV usage, incl. hidden image cells). */
  contextUsed: number;
  /** true when the response was cut by stop() (user, or app going to background). */
  stopped: boolean;
  /** true when generation was cut by the output-token cap (SendInput.maxOutputTokens). A user stop after the cap was hit still reports status 'done' + hitTokenCap. */
  hitTokenCap: boolean;
  /** The cap that applied to this response. */
  maxOutputTokens: number;
  modelId: ModelId;
};

export type ChatMessageStatus = 'streaming' | 'done' | 'stopped' | 'error';

/**
 * Machine-readable reason of an assistant message with status 'error'.
 * - context_full: send() refused BEFORE calling the model, because the estimated KV usage after this turn
 *   (ContextUsage.used + prompt + maxOutputTokens + margin) would exceed the context size. Nothing was sent,
 *   the model's history is unchanged. Recover with reset() (or a smaller maxOutputTokens). See ContextCheck.
 * - generation_failed: the library threw during the turn (message in `error`).
 */
export type ChatErrorCode = 'context_full' | 'generation_failed';

/** Numbers behind a context_full refusal (KV cells / tokens). */
export type ContextCheck = {
  /** ContextUsage.used before this turn. */
  used: number;
  /** Prompt cost: tokenize(prompt) text tokens + image tokens + CONTEXT_TEMPLATE_MARGIN. */
  promptTokens: number;
  /** Reserved for the answer (SendInput.maxOutputTokens). */
  maxOutputTokens: number;
  /** CONTEXT_SAFETY_MARGIN (stop latency, re-read template tokens). */
  margin: number;
  /** used + promptTokens + maxOutputTokens + margin. */
  required: number;
  size: number;
};

export type ChatMessage = {
  id: string;
  role: 'user' | 'assistant';
  /** assistant: accumulates while streaming. Raw model output (no tag stripping). */
  text: string;
  /** user only: the original URI passed to send() (expo-image-picker result as-is). */
  imageUri?: string;
  /** assistant only. */
  status?: ChatMessageStatus;
  /**
   * assistant only. Set when status is 'done', and when 'stopped' after generation started.
   * Absent for a 'stopped' message whose stop came before ask() (nothing was generated, nothing to measure).
   */
  metrics?: ResponseMetrics;
  /** assistant only, set when status is error. */
  error?: string;
  /** assistant only, set when status is error. */
  errorCode?: ChatErrorCode;
  /** assistant only, set when errorCode is 'context_full'. */
  contextCheck?: ContextCheck;
};

export type SendInput = {
  text: string;
  imageUri?: string;
  /**
   * Output cap. stopGeneration() is called once this many stream events arrived
   * (events <= tokens, so the real outputTokens can slightly exceed it). Default DEFAULT_MAX_OUTPUT_TOKENS (1024).
   * Use 256 for the research D-2 benchmark condition.
   */
  maxOutputTokens?: number;
};

/**
 * KV cache usage of the loaded chat.
 *
 * Why not just nobodywho getStats().contextUsed: that value is llama.cpp's position counter (n_past).
 * For M-RoPE vision models (Qwen-VL family incl. Qwen3.5) llama.cpp mtmd advances the position by
 * max(grid_w, grid_h) per image (e.g. 24) while the image really occupies grid_w * grid_h KV cells (e.g. 576).
 * `used` adds those hidden cells back, so it reflects real KV occupancy (agent-log BUG-3).
 */
export type ContextUsage = {
  /** KV cells in use = positionsUsed + hiddenImageCells. Use this for the gauge. */
  used: number;
  size: number;
  /** Raw nobodywho getStats().contextUsed (llama.cpp position counter). */
  positionsUsed: number;
  /**
   * KV cells used by images in the current context that positionsUsed does not count. 0 for text-only chats
   * and non-M-RoPE models. Inferred per image turn (accurate to a few cells per image), not reported by the library.
   */
  hiddenImageCells: number;
  /**
   * true when hiddenImageCells contains a fallback value (image grid could not be inferred, or a turn with an image
   * failed mid-way so the KV contents are unknown). `used` is then on the high (safe) side. Cleared by reset().
   */
  estimated: boolean;
};

/** Snapshot shared by all hooks (module singleton). */
export type EngineSnapshot = {
  supported: boolean;
  device: DeviceMemoryInfo;
  models: ModelEntry[];
  loadState: LoadState;
  messages: ChatMessage[];
  isGenerating: boolean;
  /**
   * true while a load/unload/reset op is queued or running. send() is ignored while true.
   * false during loadModel's download phase (the current model stays usable) -> use pendingModelId for "switching" UI.
   */
  isBusy: boolean;
  /**
   * Model requested by the latest loadModel() that is not ready yet (downloading or loading).
   * While it downloads, the previous model stays loaded and usable (loadState keeps 'ready').
   */
  pendingModelId: ModelId | null;
  contextUsage: ContextUsage | null;
};

export type Engine = {
  subscribe(listener: () => void): () => void;
  getSnapshot(): EngineSnapshot;
  /** Keeps the engine alive while > 0 holders. When the last holder releases, generation stops and the model is unloaded. */
  retain(): () => void;
  refreshDownloads(): void;
  downloadModel(id: ModelId): Promise<void>;
  deleteModel(id: ModelId): Promise<void>;
  loadModel(id: ModelId): Promise<void>;
  unloadModel(): Promise<void>;
  /**
   * Never rejects. Ignored (no message) when not ready / generating / busy / empty input.
   * When the turn could overflow the context it is refused deterministically: a user message + an assistant
   * message with status 'error', errorCode 'context_full' and contextCheck are appended, and the model is not called.
   * The check runs when the prompt has an image or the context already holds image cells (text-only chats keep
   * nobodywho's own context shift).
   */
  send(input: SendInput): Promise<void>;
  stop(): void;
  /** Clears history AND the KV cache (nobodywho resetContext). contextUsage.used is ~0 right after it resolves. */
  reset(): Promise<void>;
};
