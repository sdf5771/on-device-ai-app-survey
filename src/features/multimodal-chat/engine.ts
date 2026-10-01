/**
 * Web / fallback engine stub. Metro resolves `engine.native.ts` on iOS/Android and this file on web
 * (and TypeScript resolves this file for type-checking). It must never import react-native-nobodywho:
 * the package installs its native crate at import time and throws on web / static rendering (research A-4).
 */
import { assessFit, getDeviceMemoryInfo, MODEL_CATALOG } from './catalog';
import type { Engine, EngineSnapshot } from './types';

const device = getDeviceMemoryInfo(null);

const snapshot: EngineSnapshot = {
  supported: false,
  device,
  models: MODEL_CATALOG.map((info) => ({
    ...info,
    fit: assessFit(info, device),
    download: { status: 'notDownloaded', cachedBytes: 0 },
    isActive: false,
  })),
  loadState: { status: 'unsupported' },
  messages: [],
  isGenerating: false,
  contextUsage: null,
};

const noopAsync = async () => {};

export const engine: Engine = {
  subscribe: () => () => {},
  getSnapshot: () => snapshot,
  retain: () => () => {},
  refreshDownloads: () => {},
  downloadModel: noopAsync,
  deleteModel: noopAsync,
  loadModel: noopAsync,
  unloadModel: noopAsync,
  send: noopAsync,
  stop: () => {},
  reset: noopAsync,
};
