/**
 * Minimal local type facade for the subset of react-native-nobodywho@4.0.0 used by engine.native.ts.
 *
 * Why not `import ... from 'react-native-nobodywho'` directly:
 * the package ships raw `.ts` sources as its types (`"types": "src/wrapper.ts"`), so `tsc --noEmit`
 * type-checks the library itself under this project's `strict` settings, and `skipLibCheck` does not
 * cover `.ts` files. 4.0.0 `src/chat.ts` `tokenize()` fails that check (generated bindings return
 * `(number | undefined)[]`, wrapper declares `(number | null)[]`). Even `import type` pulls the file in.
 *
 * Signatures mirror node_modules/react-native-nobodywho/src/{wrapper,model,chat,prompt,streaming}.ts.
 * Re-check this file on every nobodywho upgrade (research: major releases every ~3-4 weeks).
 * Type-only file: no runtime code, safe to import on web.
 */

export interface NwModel {
  readonly maxCtx: number;
  destroy(): void;
}

export interface NwChatStats {
  contextSize: number;
  contextUsed: number;
}

declare const promptBrand: unique symbol;
declare const partBrand: unique symbol;

export interface NwPrompt {
  readonly [promptBrand]: true;
}

export interface NwPromptPart {
  readonly [partBrand]: true;
}

export interface NwChat {
  ask(message: string | NwPrompt): AsyncIterable<string>;
  stopGeneration(): void;
  /** Clears messages only. Does NOT touch the KV cache / position counter until the next ask() (core set_chat_history). */
  resetHistory(): Promise<void>;
  /**
   * Clears messages, the KV cache (n_past = 0) and the KV mirror (core reset_chat -> engine.reset_context).
   * Template variables and sampler config are kept. systemPrompt undefined = no system prompt.
   */
  resetContext(opts?: { systemPrompt?: string }): Promise<void>;
  getStats(): Promise<NwChatStats>;
  /** Image/audio embedding slots are `undefined` at runtime (generated bindings), documented as `null`. */
  tokenize(message: string | NwPrompt): Promise<(number | null | undefined)[]>;
  destroy(): void;
}

export interface NwChatOptions {
  model: NwModel;
  systemPrompt?: string;
  contextSize?: number;
  templateVariables?: Record<string, boolean>;
  threadCount?: number;
}

export interface NobodyWhoApi {
  Model: {
    load(opts: {
      modelPath: string;
      useGpu?: boolean;
      projectionModelPath?: string;
      onDownloadProgress?: (downloaded: number, total: number) => void;
    }): Promise<NwModel>;
  };
  Chat: new (opts: NwChatOptions) => NwChat;
  Prompt: {
    new (parts: NwPromptPart[]): NwPrompt;
    Text(content: string): NwPromptPart;
    Image(path: string): NwPromptPart;
  };
  downloadModel(opts: {
    modelPath: string;
    headers?: Record<string, string>;
    onDownloadProgress?: (downloaded: number, total: number) => void;
  }): Promise<string>;
  /** `size` is a bigint (Rust u64). */
  getCachedModels(): { path: string; size: bigint }[];
}
