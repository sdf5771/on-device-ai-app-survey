import { Image } from 'expo-image';
import { StyleSheet, View } from 'react-native';

import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { Spacing, type ThemeColor } from '@/constants/theme';
import type { ChatMessage, ChatMessageStatus, ResponseMetrics } from '@/features/multimodal-chat';
import { formatMs } from '@/utils/format';

const STATUS_LABEL: Record<ChatMessageStatus, { label: string; color: ThemeColor }> = {
  streaming: { label: '생성 중…', color: 'tint' },
  done: { label: '완료', color: 'textSecondary' },
  stopped: { label: '중단됨', color: 'warning' },
  error: { label: '오류', color: 'danger' },
};

export function MessageBubble({ message }: { message: ChatMessage }) {
  if (message.role === 'user') {
    return (
      <View style={[styles.row, styles.userRow]}>
        <ThemedView type="backgroundSelected" style={[styles.bubble, styles.userBubble]}>
          {message.imageUri && (
            <Image
              source={{ uri: message.imageUri }}
              style={styles.image}
              contentFit="cover"
              accessibilityLabel="첨부한 이미지"
            />
          )}
          {message.text.length > 0 && <ThemedText selectable>{message.text}</ThemedText>}
        </ThemedView>
      </View>
    );
  }

  const status = STATUS_LABEL[message.status ?? 'done'];
  const isEmptyStreaming = message.status === 'streaming' && message.text.length === 0;

  return (
    <View style={styles.row}>
      <ThemedView type="backgroundElement" style={styles.bubble}>
        {isEmptyStreaming ? (
          <ThemedText themeColor="textSecondary">…</ThemedText>
        ) : (
          message.text.length > 0 && <ThemedText selectable>{message.text}</ThemedText>
        )}
        <ThemedText type="code" themeColor={status.color}>
          {status.label}
          {message.status === 'error' && message.error ? ` · ${message.error}` : ''}
        </ThemedText>
        {message.metrics ? (
          <MetricsLine metrics={message.metrics} />
        ) : (
          message.status === 'stopped' && (
            <ThemedText type="code" themeColor="textSecondary">
              계측 없음 (생성 시작 전 중단)
            </ThemedText>
          )
        )}
      </ThemedView>
    </View>
  );
}

function MetricsLine({ metrics: m }: { metrics: ResponseMetrics }) {
  const parts = [
    `TTFT ${formatMs(m.ttftMs)}`,
    `${m.tokensPerSec.toFixed(1)} tok/s`,
    `출력 ${m.outputTokens} tok`,
    `총 ${formatMs(m.totalMs)}`,
  ];
  if (m.promptTokens != null) parts.push(`프롬프트 ${m.promptTokens} tok`);
  if (m.imageTokens != null) parts.push(`이미지 ${m.imageTokens} tok`);
  if (m.imagePrepMs != null) parts.push(`이미지 전처리 ${formatMs(m.imagePrepMs)}`);
  if (m.hitTokenCap) parts.push(`출력 상한(${m.maxOutputTokens}) 도달`);
  if (m.stopped) parts.push('stopped(사용자·백그라운드 중단)');

  return (
    <ThemedText type="code" themeColor="textSecondary" selectable>
      {parts.join(' · ')}
    </ThemedText>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
  },
  userRow: {
    justifyContent: 'flex-end',
  },
  bubble: {
    maxWidth: '90%',
    padding: Spacing.three,
    paddingVertical: Spacing.two,
    borderRadius: Spacing.three,
    gap: Spacing.one,
  },
  userBubble: {
    maxWidth: '80%',
  },
  image: {
    width: 180,
    height: 180,
    borderRadius: Spacing.two,
  },
});
