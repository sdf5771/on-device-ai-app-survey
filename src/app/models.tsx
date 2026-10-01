import { useState } from 'react';
import { Platform, ScrollView, StyleSheet } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { LoadStatus } from '@/components/models/load-status';
import { ModelCard } from '@/components/models/model-card';
import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { BottomTabInset, MaxContentWidth, Spacing } from '@/constants/theme';
import { useModelManager, type ModelEntry } from '@/features/multimodal-chat';
import { useTheme } from '@/hooks/use-theme';
import { formatBytes } from '@/utils/format';

type PendingConfirm = { kind: 'load' | 'delete'; model: ModelEntry } | null;

export default function ModelsScreen() {
  const safeAreaInsets = useSafeAreaInsets();
  const insets = {
    ...safeAreaInsets,
    bottom: safeAreaInsets.bottom + BottomTabInset + Spacing.three,
  };
  const theme = useTheme();
  const { supported, device, models, loadState, pendingModelId, isBusy, downloadModel, deleteModel, loadModel } =
    useModelManager();
  const [confirm, setConfirm] = useState<PendingConfirm>(null);

  const contentPlatformStyle = Platform.select({
    android: {
      paddingTop: insets.top,
      paddingLeft: insets.left,
      paddingRight: insets.right,
      paddingBottom: insets.bottom,
    },
    web: {
      paddingTop: Spacing.six + Spacing.four,
      paddingBottom: Spacing.four,
    },
  });

  const onUse = (model: ModelEntry) => {
    if (model.fit === 'notRecommended') {
      setConfirm({ kind: 'load', model });
      return;
    }
    void loadModel(model.id);
  };

  const onConfirm = () => {
    if (!confirm) return;
    if (confirm.kind === 'load') void loadModel(confirm.model.id);
    else void deleteModel(confirm.model.id);
    setConfirm(null);
  };

  return (
    <ScrollView
      style={[styles.scrollView, { backgroundColor: theme.background }]}
      contentInset={insets}
      scrollIndicatorInsets={insets}
      contentContainerStyle={[styles.contentContainer, contentPlatformStyle]}>
      <ThemedView style={styles.container}>
        <ThemedText type="subtitle">모델</ThemedText>

        <ThemedView type="backgroundElement" style={styles.section}>
          <ThemedText type="smallBold">기기 메모리</ThemedText>
          {device.totalMemoryBytes == null ? (
            <ThemedText type="small" themeColor="textSecondary">
              기기 RAM 정보를 알 수 없습니다 (추천 배지 없음)
            </ThemedText>
          ) : (
            <ThemedText type="small">
              RAM {formatBytes(device.totalMemoryBytes)} · 추천 ≤{' '}
              {formatBytes(device.recommendedBudgetBytes ?? 0)} · 경계 ≤{' '}
              {formatBytes(device.borderlineBudgetBytes ?? 0)}
            </ThemedText>
          )}
          <ThemedText type="small" themeColor="textSecondary">
            예상 메모리가 추천 예산 이하면 추천, 경계 예산 이하면 경계, 초과하면 비추천입니다
            (추정치, 실측 아님).
          </ThemedText>
        </ThemedView>

        <ThemedView type="backgroundElement" style={styles.section}>
          <ThemedText type="smallBold">현재 모델</ThemedText>
          <LoadStatus loadState={loadState} pendingModelId={pendingModelId} />
          {isBusy && (
            <ThemedText type="small" themeColor="textSecondary">
              모델 작업 처리 중…
            </ThemedText>
          )}
        </ThemedView>

        {supported ? (
          <ThemedText type="small" themeColor="warning">
            다운로드는 취소할 수 없고, 앱이 백그라운드로 가면 중단될 수 있습니다. 다운로드 중에는
            앱을 열어 두세요.
          </ThemedText>
        ) : (
          <ThemedText type="small" themeColor="warning">
            웹에서는 모델을 받거나 실행할 수 없습니다. iOS/Android 개발 빌드에서 확인하세요.
          </ThemedText>
        )}

        {models.map((m) => (
          <ModelCard
            key={m.id}
            model={m}
            isSupported={supported}
            isInUse={loadState.status === 'ready' && loadState.modelId === m.id}
            isPending={m.id === pendingModelId}
            onDownload={() => void downloadModel(m.id)}
            onUse={() => onUse(m)}
            onDelete={() => setConfirm({ kind: 'delete', model: m })}
          />
        ))}
      </ThemedView>

      <ConfirmDialog
        isVisible={confirm !== null}
        title={
          confirm?.kind === 'load'
            ? `${confirm.model.name}을(를) 불러올까요?`
            : `${confirm?.model.name ?? ''}을(를) 삭제할까요?`
        }
        message={
          confirm?.kind === 'load'
            ? `이 기기에서는 비추천 모델입니다. 예상 메모리 ${formatBytes(confirm.model.estimatedMemoryBytes)}로 메모리 부족(OOM)으로 앱이 종료될 수 있습니다. 현재 대화는 초기화됩니다.`
            : '받은 모델 파일을 기기에서 지웁니다. 다시 쓰려면 다시 받아야 합니다.'
        }
        confirmLabel={confirm?.kind === 'load' ? '불러오기' : '삭제'}
        isDestructive
        onConfirm={onConfirm}
        onCancel={() => setConfirm(null)}
      />
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  scrollView: {
    flex: 1,
  },
  contentContainer: {
    flexDirection: 'row',
    justifyContent: 'center',
  },
  container: {
    maxWidth: MaxContentWidth,
    flexGrow: 1,
    gap: Spacing.three,
    paddingHorizontal: Spacing.three,
    paddingVertical: Spacing.four,
  },
  section: {
    padding: Spacing.three,
    borderRadius: Spacing.three,
    gap: Spacing.one,
  },
});
