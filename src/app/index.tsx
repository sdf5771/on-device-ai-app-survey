import { useRouter } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { FlatList, Keyboard, KeyboardAvoidingView, Platform, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { ChatComposer } from '@/components/chat/chat-composer';
import { MessageBubble } from '@/components/chat/message-bubble';
import { LoadStatus } from '@/components/models/load-status';
import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { Button } from '@/components/ui/button';
import { BottomTabInset, MaxContentWidth, Spacing } from '@/constants/theme';
import { useMultimodalChat, type ChatMessage } from '@/features/multimodal-chat';
import { formatPercent } from '@/utils/format';

function useIsKeyboardVisible() {
  const [isVisible, setIsVisible] = useState(false);
  useEffect(() => {
    const showEvent = Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow';
    const hideEvent = Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide';
    const show = Keyboard.addListener(showEvent, () => setIsVisible(true));
    const hide = Keyboard.addListener(hideEvent, () => setIsVisible(false));
    return () => {
      show.remove();
      hide.remove();
    };
  }, []);
  return isVisible;
}

export default function ChatScreen() {
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const isKeyboardVisible = useIsKeyboardVisible();
  const listRef = useRef<FlatList<ChatMessage>>(null);
  const {
    supported,
    loadState,
    messages,
    isGenerating,
    isBusy,
    pendingModelId,
    send,
    stop,
    reset,
    contextUsage,
  } = useMultimodalChat();

  const isReady = loadState.status === 'ready';
  const hasNoModel =
    (loadState.status === 'idle' || loadState.status === 'error') && pendingModelId === null;

  const topPadding = Platform.OS === 'web' ? Spacing.six + Spacing.four : insets.top;
  // The native tab bar overlaps the screen bottom; the keyboard covers it while open.
  const bottomPadding = isKeyboardVisible
    ? Spacing.two
    : insets.bottom + BottomTabInset + Spacing.two;

  if (!supported) {
    return (
      <ThemedView style={[styles.screen, styles.centered, { paddingTop: topPadding }]}>
        <ThemedView type="backgroundElement" style={styles.notice}>
          <ThemedText type="smallBold">웹에서는 지원하지 않습니다</ThemedText>
          <ThemedText type="small" themeColor="textSecondary">
            온디바이스 추론은 iOS/Android 개발 빌드에서만 동작합니다.
          </ThemedText>
        </ThemedView>
      </ThemedView>
    );
  }

  return (
    <ThemedView style={styles.screen}>
      <KeyboardAvoidingView
        style={styles.screen}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <View style={[styles.content, { paddingTop: topPadding, paddingBottom: bottomPadding }]}>
          <View style={styles.header}>
            <View style={styles.headerTitle}>
              <ThemedText type="subtitle">채팅</ThemedText>
              <Button
                title="대화 초기화"
                onPress={() => void reset()}
                disabled={!isReady || isBusy || isGenerating || messages.length === 0}
              />
            </View>
            <LoadStatus loadState={loadState} pendingModelId={pendingModelId} />
            {contextUsage && (
              <ThemedText type="code" themeColor="textSecondary">
                컨텍스트 {contextUsage.used} / {contextUsage.size} tok (
                {formatPercent(contextUsage.size > 0 ? contextUsage.used / contextUsage.size : 0)})
              </ThemedText>
            )}
          </View>

          {hasNoModel ? (
            <View style={styles.body}>
              <ThemedView type="backgroundElement" style={styles.notice}>
                <ThemedText type="smallBold">불러온 모델이 없습니다</ThemedText>
                <ThemedText type="small" themeColor="textSecondary">
                  모델 탭에서 모델을 받은 뒤 사용을 눌러 불러오세요.
                </ThemedText>
                <Button
                  title="모델 탭으로 이동"
                  variant="primary"
                  onPress={() => router.navigate('/models')}
                />
              </ThemedView>
            </View>
          ) : (
            <FlatList
              ref={listRef}
              style={styles.body}
              data={messages}
              keyExtractor={(m) => m.id}
              renderItem={({ item }) => <MessageBubble message={item} />}
              contentContainerStyle={styles.list}
              keyboardDismissMode="interactive"
              keyboardShouldPersistTaps="handled"
              onContentSizeChange={() => listRef.current?.scrollToEnd({ animated: false })}
              ListEmptyComponent={
                isReady ? (
                  <ThemedText type="small" themeColor="textSecondary" style={styles.empty}>
                    메시지를 입력하거나 사진을 첨부해 보세요.
                  </ThemedText>
                ) : null
              }
            />
          )}

          <ChatComposer
            isSendBlocked={!isReady || isBusy || isGenerating}
            isGenerating={isGenerating}
            onSend={(input) => void send(input)}
            onStop={stop}
          />
        </View>
      </KeyboardAvoidingView>
    </ThemedView>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
  },
  centered: {
    alignItems: 'center',
    justifyContent: 'center',
    padding: Spacing.three,
  },
  content: {
    flex: 1,
    width: '100%',
    maxWidth: MaxContentWidth,
    alignSelf: 'center',
    paddingHorizontal: Spacing.three,
    gap: Spacing.two,
  },
  header: {
    gap: Spacing.one,
  },
  headerTitle: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: Spacing.two,
  },
  body: {
    flex: 1,
  },
  list: {
    gap: Spacing.two,
    paddingVertical: Spacing.two,
  },
  notice: {
    padding: Spacing.three,
    borderRadius: Spacing.three,
    gap: Spacing.two,
    maxWidth: MaxContentWidth,
    width: '100%',
  },
  empty: {
    textAlign: 'center',
    marginTop: Spacing.four,
  },
});
