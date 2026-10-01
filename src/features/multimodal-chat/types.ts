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
  /** Prefill tokens incl. chat template and image tokens = contextUsed delta - outputTokens. Undefined if context shift happened. */
  promptTokens?: number;
  /** Image embedding slots in the prompt (null entries from chat.tokenize(prompt)). Only when an image was sent. */
  imageTokens?: number;
  /** Image preprocessing (resize + JPEG) time (ms). Not included in ttftMs. */
  imagePrepMs?: number;
  /** Context usage after this response. */
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

export type ContextUsage = { used: number; size: number };

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
  send(input: SendInput): Promise<void>;
  stop(): void;
  reset(): Promise<void>;
};
