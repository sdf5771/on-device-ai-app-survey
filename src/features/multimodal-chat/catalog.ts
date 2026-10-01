/**
 * Multimodal model catalog + RAM-based fit assessment.
 * Pure TS (no native imports) so the web stub and screens can use it directly.
 *
 * File sizes: Hugging Face API `/api/models/NobodyWho/<repo>/tree/main`, checked 2026-10-01.
 * Memory estimates: agent-log/research.md C-4 (estimate, not measured).
 */
import type { DeviceMemoryInfo, ModelFit, ModelId, ModelInfo } from './types';

const MB = 1_000_000;

/** Runtime overhead (llama.cpp/Metal buffers, compute graph). research C-4: ~0.3–0.5GB, upper-ish value used. Estimate. */
const RUNTIME_OVERHEAD_BYTES = 400 * MB;

/**
 * Context size used for every chat. Library default, and research D-1 benchmark condition.
 * Multimodal needs >= 2048 (docs: vision guide); one resized image costs <= ~576 tokens (see image.native.ts).
 */
export const CONTEXT_SIZE = 4096;

/** Default model when nothing else is chosen (PM decision 2026-10-01: Qwen3.5-2B is the main candidate). */
export const DEFAULT_MODEL_ID: ModelId = 'qwen3.5-2b';

type CatalogSeed = Omit<ModelInfo, 'downloadBytes' | 'estimatedMemoryBytes'> & {
  /** f16 KV cache at CONTEXT_SIZE (research C-4). Estimate. */
  kvCacheBytes: number;
};

const SEEDS: CatalogSeed[] = [
  {
    id: 'qwen3.5-0.8b',
    name: 'Qwen3.5 0.8B',
    description: '가장 가벼운 비전 모델. 속도 기준선용, 품질은 낮을 수 있음',
    quantization: 'Q4_K_M',
    modelPath: 'hf://NobodyWho/Qwen_Qwen3.5-0.8B-GGUF/Qwen_Qwen3.5-0.8B-Q4_K_M-vendor-sampling.gguf',
    projectionPath: 'hf://NobodyWho/Qwen_Qwen3.5-0.8B-GGUF/mmproj-BF16.gguf',
    modelBytes: 532_517_344,
    projectionBytes: 207_346_528,
    kvCacheBytes: 50 * MB,
    license: 'Apache-2.0',
  },
  {
    id: 'qwen3.5-2b',
    name: 'Qwen3.5 2B',
    description: '주력 후보. 품질과 속도의 균형',
    quantization: 'Q4_K_M',
    modelPath: 'hf://NobodyWho/Qwen_Qwen3.5-2B-GGUF/Qwen_Qwen3.5-2B-Q4_K_M-vendor-sampling.gguf',
    projectionPath: 'hf://NobodyWho/Qwen_Qwen3.5-2B-GGUF/mmproj-BF16.gguf',
    modelBytes: 1_280_836_064,
    projectionBytes: 671_372_992,
    kvCacheBytes: 50 * MB,
    license: 'Apache-2.0',
  },
  {
    id: 'qwen3.5-4b',
    name: 'Qwen3.5 4B',
    description: '품질 상한 후보. 8GB 기기에서는 메모리 경계',
    quantization: 'Q4_K_M',
    modelPath: 'hf://NobodyWho/Qwen_Qwen3.5-4B-GGUF/Qwen_Qwen3.5-4B-Q4_K_M-vendor-sampling.gguf',
    projectionPath: 'hf://NobodyWho/Qwen_Qwen3.5-4B-GGUF/mmproj-BF16.gguf',
    modelBytes: 2_740_938_080,
    projectionBytes: 675_569_344,
    kvCacheBytes: 134 * MB,
    license: 'Apache-2.0',
  },
  {
    id: 'gemma4-e2b',
    name: 'Gemma 4 E2B',
    description: 'Google 비전 모델(실효 2.3B). 파일이 커서 메모리 부담이 큼',
    quantization: 'Q4_K_M',
    modelPath: 'hf://NobodyWho/Google_Gemma4-E2B-GGUF/gemma-4-E2B-it-Q4_K_M.gguf',
    projectionPath: 'hf://NobodyWho/Google_Gemma4-E2B-GGUF/mmproj-BF16.gguf',
    modelBytes: 3_106_736_256,
    projectionBytes: 986_833_728,
    // Not computed in research (SWA + shared KV, expected small). Assumed 150MB. Estimate.
    kvCacheBytes: 150 * MB,
    license: 'Apache-2.0',
  },
];

export const MODEL_CATALOG: readonly ModelInfo[] = SEEDS.map(({ kvCacheBytes, ...seed }) => ({
  ...seed,
  downloadBytes: seed.modelBytes + seed.projectionBytes,
  estimatedMemoryBytes: seed.modelBytes + seed.projectionBytes + kvCacheBytes + RUNTIME_OVERHEAD_BYTES,
}));

export function getModelInfo(id: ModelId): ModelInfo {
  const info = MODEL_CATALOG.find((m) => m.id === id);
  if (!info) throw new Error(`Unknown model id: ${id}`);
  return info;
}

/**
 * RAM fit thresholds — single source of truth.
 *
 * Basis (agent-log/research.md C-3, estimates until os_proc_available_memory is measured):
 * - iOS jetsam limit for a foreground app is assumed ~50–60% of physical RAM.
 *   -> BORDERLINE_RATIO = 0.5: above this the app is likely to be killed.
 * - Safe budget for model + KV + runtime: ~4GB on iPhone 17 Pro (12GB), ~2.5–3GB on iPad Pro M4 (8GB),
 *   i.e. about one third of physical RAM. -> RECOMMENDED_RATIO = 1/3.
 *   (12 GiB * 1/3 ≈ 4.3GB, 8 GiB * 1/3 ≈ 2.9GB)
 * Resulting fit (estimates): iPhone 17 Pro -> 0.8B/2B/4B recommended, Gemma4-E2B borderline.
 *                            iPad Pro M4 8GB -> 0.8B/2B recommended, 4B borderline, Gemma4-E2B notRecommended.
 * nobodywho 4.0.0 exposes no available-memory API to JS (only Rust-internal), so physical RAM is the only input.
 */
export const RECOMMENDED_RATIO = 1 / 3;
export const BORDERLINE_RATIO = 0.5;

export function getDeviceMemoryInfo(totalMemoryBytes: number | null): DeviceMemoryInfo {
  if (totalMemoryBytes == null || totalMemoryBytes <= 0) {
    return { totalMemoryBytes: null, recommendedBudgetBytes: null, borderlineBudgetBytes: null };
  }
  return {
    totalMemoryBytes,
    recommendedBudgetBytes: Math.floor(totalMemoryBytes * RECOMMENDED_RATIO),
    borderlineBudgetBytes: Math.floor(totalMemoryBytes * BORDERLINE_RATIO),
  };
}

export function assessFit(model: ModelInfo, device: DeviceMemoryInfo): ModelFit {
  if (device.recommendedBudgetBytes == null || device.borderlineBudgetBytes == null) return 'unknown';
  if (model.estimatedMemoryBytes <= device.recommendedBudgetBytes) return 'recommended';
  if (model.estimatedMemoryBytes <= device.borderlineBudgetBytes) return 'borderline';
  return 'notRecommended';
}
