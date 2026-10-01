import { StyleSheet, View } from 'react-native';

import { ThemedText } from '@/components/themed-text';
import { ProgressBar } from '@/components/ui/progress-bar';
import { Spacing } from '@/constants/theme';
import {
  getModelInfo,
  type LoadErrorCode,
  type LoadState,
  type ModelId,
} from '@/features/multimodal-chat';
import { formatBytes, formatMs, formatPercent } from '@/utils/format';

const ERROR_HINT: Record<LoadErrorCode, string> = {
  insufficient_memory: '메모리가 부족합니다. 더 작은 모델을 선택하세요.',
  download_failed: '다운로드에 실패했습니다. 네트워크를 확인하고 다시 시도하세요.',
  load_failed: '모델을 불러오지 못했습니다.',
  unknown: '알 수 없는 오류가 발생했습니다.',
};

type LoadStatusProps = {
  loadState: LoadState;
  pendingModelId: ModelId | null;
};

/** Current model state shared by the chat and models screens. */
export function LoadStatus({ loadState, pendingModelId }: LoadStatusProps) {
  return (
    <View style={styles.container}>
      <StateLine loadState={loadState} />
      {pendingModelId &&
        loadState.status === 'ready' &&
        loadState.modelId !== pendingModelId && (
          <ThemedText type="small" themeColor="tint">
            {getModelInfo(pendingModelId).name}(으)로 전환 준비 중 · 다운로드가 끝날 때까지 현재
            모델을 계속 쓸 수 있습니다
          </ThemedText>
        )}
    </View>
  );
}

function StateLine({ loadState: s }: { loadState: LoadState }) {
  switch (s.status) {
    case 'idle':
      return <ThemedText type="small">불러온 모델 없음</ThemedText>;
    case 'unsupported':
      return (
        <ThemedText type="small" themeColor="textSecondary">
          웹에서는 모델을 실행할 수 없습니다
        </ThemedText>
      );
    case 'downloading':
      return (
        <View style={styles.progress}>
          <ThemedText type="small">
            {getModelInfo(s.modelId).name} 다운로드 중 · {formatBytes(s.downloadedBytes)} /{' '}
            {formatBytes(s.totalBytes)} · {formatPercent(s.progress)}
          </ThemedText>
          <ProgressBar progress={s.progress} />
        </View>
      );
    case 'loading':
      return <ThemedText type="small">{getModelInfo(s.modelId).name} 불러오는 중…</ThemedText>;
    case 'ready':
      return (
        <ThemedText type="small">
          <ThemedText type="smallBold">{getModelInfo(s.modelId).name}</ThemedText> 사용 중 · 로드{' '}
          {formatMs(s.loadMs)} · 컨텍스트 {s.contextSize}
        </ThemedText>
      );
    case 'error':
      return (
        <View style={styles.progress}>
          <ThemedText type="smallBold" themeColor="danger">
            {s.modelId ? `${getModelInfo(s.modelId).name} ` : ''}오류 ({s.code})
          </ThemedText>
          <ThemedText type="small" themeColor="danger">
            {ERROR_HINT[s.code]}
          </ThemedText>
          <ThemedText type="code" themeColor="textSecondary">
            {s.message}
          </ThemedText>
        </View>
      );
  }
}

const styles = StyleSheet.create({
  container: {
    gap: Spacing.one,
  },
  progress: {
    gap: Spacing.one,
  },
});
