/**
 * React hooks over the engine singleton. State is shared across screens
 * (model selection screen and chat screen see the same loaded model).
 */
import { useEffect, useSyncExternalStore } from 'react';

import { engine } from './engine';
import type { EngineSnapshot } from './types';

function useEngineSnapshot(): EngineSnapshot {
  const snapshot = useSyncExternalStore(engine.subscribe, engine.getSnapshot, engine.getSnapshot);
  // While any hook is mounted the model stays loaded; after the last one unmounts,
  // generation is stopped and the model/chat are destroyed.
  useEffect(() => engine.retain(), []);
  return snapshot;
}

/** Model selection screen: catalog, RAM fit, download/delete, load/switch. */
export function useModelManager() {
  const s = useEngineSnapshot();
  useEffect(() => {
    engine.refreshDownloads();
  }, []);
  return {
    supported: s.supported,
    device: s.device,
    models: s.models,
    loadState: s.loadState,
    pendingModelId: s.pendingModelId,
    isBusy: s.isBusy,
    refreshDownloads: engine.refreshDownloads,
    downloadModel: engine.downloadModel,
    deleteModel: engine.deleteModel,
    loadModel: engine.loadModel,
    unloadModel: engine.unloadModel,
  };
}

/** Chat screen: messages, streaming, stop, reset (+ loadModel for convenience). */
export function useMultimodalChat() {
  const s = useEngineSnapshot();
  return {
    supported: s.supported,
    loadState: s.loadState,
    loadModel: engine.loadModel,
    messages: s.messages,
    isGenerating: s.isGenerating,
    isBusy: s.isBusy,
    pendingModelId: s.pendingModelId,
    send: engine.send,
    stop: engine.stop,
    reset: engine.reset,
    contextUsage: s.contextUsage,
  };
}

export type UseModelManagerResult = ReturnType<typeof useModelManager>;
export type UseMultimodalChatResult = ReturnType<typeof useMultimodalChat>;
