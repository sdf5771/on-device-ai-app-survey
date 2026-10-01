import { StyleSheet, View } from 'react-native';

import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { Button } from '@/components/ui/button';
import { ProgressBar } from '@/components/ui/progress-bar';
import { Spacing, type ThemeColor } from '@/constants/theme';
import type { ModelDownloadState, ModelEntry, ModelFit } from '@/features/multimodal-chat';
import { formatBytes, formatPercent } from '@/utils/format';

const FIT_LABEL: Record<Exclude<ModelFit, 'unknown'>, { label: string; color: ThemeColor }> = {
  recommended: { label: '추천', color: 'success' },
  borderline: { label: '경계', color: 'warning' },
  notRecommended: { label: '비추천 · OOM 위험', color: 'danger' },
};

type ModelCardProps = {
  model: ModelEntry;
  isSupported: boolean;
  /** loadState is ready with this model */
  isInUse: boolean;
  /** this model is pendingModelId (downloading/loading for a switch) */
  isPending: boolean;
  onDownload: () => void;
  onUse: () => void;
  onDelete: () => void;
};

export function ModelCard({
  model,
  isSupported,
  isInUse,
  isPending,
  onDownload,
  onUse,
  onDelete,
}: ModelCardProps) {
  const d = model.download;
  const canDownload = isSupported && (d.status === 'notDownloaded' || d.status === 'error');
  const canUse = isSupported && !model.isActive && !isPending;
  const canDelete = isSupported && d.status === 'downloaded' && !model.isActive && !isPending;

  return (
    <ThemedView type="backgroundElement" style={styles.card}>
      <View style={styles.titleRow}>
        <ThemedText type="smallBold" style={styles.title}>
          {model.name}
        </ThemedText>
        {model.fit !== 'unknown' && <Tag {...FIT_LABEL[model.fit]} />}
        {isInUse && <Tag label="사용 중" color="tint" />}
        {!isInUse && model.isActive && <Tag label="불러오는 중" color="tint" />}
        {isPending && !model.isActive && <Tag label="전환 대기" color="tint" />}
      </View>

      <ThemedText type="small" themeColor="textSecondary">
        {model.description}
      </ThemedText>

      <ThemedText type="code" themeColor="textSecondary">
        다운로드 {formatBytes(model.downloadBytes)} · 예상 메모리{' '}
        {formatBytes(model.estimatedMemoryBytes)} · {model.quantization} · {model.license}
      </ThemedText>

      <DownloadStatus download={d} />

      <View style={styles.actions}>
        <Button
          title={d.status === 'error' ? '다시 받기' : '다운로드'}
          onPress={onDownload}
          disabled={!canDownload}
        />
        <Button title="사용" variant="primary" onPress={onUse} disabled={!canUse} />
        <Button title="삭제" variant="danger" onPress={onDelete} disabled={!canDelete} />
      </View>
    </ThemedView>
  );
}

function Tag({ label, color }: { label: string; color: ThemeColor }) {
  return (
    <ThemedView type="backgroundSelected" style={styles.tag}>
      <ThemedText type="smallBold" themeColor={color} style={styles.tagText}>
        {label}
      </ThemedText>
    </ThemedView>
  );
}

function DownloadStatus({ download: d }: { download: ModelDownloadState }) {
  switch (d.status) {
    case 'notDownloaded':
      return (
        <ThemedText type="small" themeColor="textSecondary">
          {d.cachedBytes > 0 ? `일부만 받음 (${formatBytes(d.cachedBytes)})` : '받지 않음'}
        </ThemedText>
      );
    case 'queued':
      return (
        <ThemedText type="small" themeColor="textSecondary">
          다운로드 대기 중 (다른 모델 다운로드 후 시작)
        </ThemedText>
      );
    case 'downloading':
      return (
        <View style={styles.progress}>
          <ProgressBar progress={d.progress} />
          <ThemedText type="code" themeColor="textSecondary">
            {d.file === 'model' ? '모델 파일' : '비전 파일(mmproj)'} 받는 중 ·{' '}
            {formatBytes(d.downloadedBytes)} / {formatBytes(d.totalBytes)} ·{' '}
            {formatPercent(d.progress)}
          </ThemedText>
        </View>
      );
    case 'downloaded':
      return (
        <ThemedText type="small" themeColor="success">
          받음 ({formatBytes(d.sizeBytes)})
        </ThemedText>
      );
    case 'error':
      return (
        <ThemedText type="small" themeColor="danger">
          다운로드 실패: {d.message}
        </ThemedText>
      );
  }
}

const styles = StyleSheet.create({
  card: {
    padding: Spacing.three,
    borderRadius: Spacing.three,
    gap: Spacing.two,
  },
  titleRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: Spacing.two,
  },
  title: {
    fontSize: 16,
  },
  tag: {
    paddingHorizontal: Spacing.two,
    borderRadius: Spacing.one,
  },
  tagText: {
    fontSize: 12,
    lineHeight: 18,
  },
  progress: {
    gap: Spacing.one,
  },
  actions: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: Spacing.two,
    marginTop: Spacing.one,
  },
});
