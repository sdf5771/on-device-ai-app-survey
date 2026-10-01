import { Image } from 'expo-image';
import * as ImagePicker from 'expo-image-picker';
import { useState } from 'react';
import { Pressable, StyleSheet, TextInput, View } from 'react-native';

import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { Button } from '@/components/ui/button';
import { Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';

type ChatComposerProps = {
  /** Model not ready / busy / generating. Input stays editable; only sending is blocked. */
  isSendBlocked: boolean;
  isGenerating: boolean;
  onSend: (input: { text: string; imageUri?: string }) => void;
  onStop: () => void;
};

export function ChatComposer({ isSendBlocked, isGenerating, onSend, onStop }: ChatComposerProps) {
  const theme = useTheme();
  const [text, setText] = useState('');
  const [imageUri, setImageUri] = useState<string>();
  const [pickerError, setPickerError] = useState<string>();

  const hasContent = text.trim().length > 0 || imageUri !== undefined;
  const isSendDisabled = isSendBlocked || !hasContent;

  const pickFromLibrary = async () => {
    setPickerError(undefined);
    try {
      const result = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['images'] });
      if (!result.canceled) setImageUri(result.assets[0].uri);
    } catch (e) {
      setPickerError(`사진을 불러오지 못했습니다: ${String(e)}`);
    }
  };

  const takePhoto = async () => {
    setPickerError(undefined);
    try {
      const permission = await ImagePicker.requestCameraPermissionsAsync();
      if (!permission.granted) {
        setPickerError('카메라 권한이 없습니다. 설정에서 카메라 접근을 허용하세요.');
        return;
      }
      const result = await ImagePicker.launchCameraAsync({ mediaTypes: ['images'] });
      if (!result.canceled) setImageUri(result.assets[0].uri);
    } catch (e) {
      // e.g. simulator has no camera
      setPickerError(`카메라를 열지 못했습니다: ${String(e)}`);
    }
  };

  const submit = () => {
    if (isSendDisabled) return;
    onSend({ text: text.trim(), imageUri });
    setText('');
    setImageUri(undefined);
  };

  return (
    <View style={styles.container}>
      {imageUri && (
        <View style={styles.preview}>
          <Image source={{ uri: imageUri }} style={styles.thumbnail} contentFit="cover" />
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="첨부 이미지 제거"
            hitSlop={8}
            onPress={() => setImageUri(undefined)}
            style={({ pressed }) => [
              styles.removeButton,
              { backgroundColor: theme.text },
              pressed && styles.pressed,
            ]}>
            <ThemedText type="smallBold" style={{ color: theme.background }}>
              ✕
            </ThemedText>
          </Pressable>
        </View>
      )}

      {pickerError && (
        <ThemedText type="small" themeColor="danger">
          {pickerError}
        </ThemedText>
      )}

      <View style={styles.row}>
        <Button title="사진" onPress={pickFromLibrary} disabled={isGenerating} />
        <Button title="카메라" onPress={takePhoto} disabled={isGenerating} />
        <ThemedView type="backgroundElement" style={styles.inputWrap}>
          <TextInput
            value={text}
            onChangeText={setText}
            placeholder="메시지 입력"
            placeholderTextColor={theme.textSecondary}
            multiline
            style={[styles.input, { color: theme.text }]}
            accessibilityLabel="메시지 입력"
          />
        </ThemedView>
        {isGenerating ? (
          <Button title="중지" variant="danger" onPress={onStop} />
        ) : (
          <Button title="전송" variant="primary" onPress={submit} disabled={isSendDisabled} />
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    gap: Spacing.two,
  },
  preview: {
    alignSelf: 'flex-start',
  },
  thumbnail: {
    width: 72,
    height: 72,
    borderRadius: Spacing.two,
  },
  removeButton: {
    position: 'absolute',
    top: -Spacing.two,
    right: -Spacing.two,
    width: 24,
    height: 24,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
  },
  pressed: {
    opacity: 0.7,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: Spacing.two,
  },
  inputWrap: {
    flex: 1,
    borderRadius: Spacing.two,
    paddingHorizontal: Spacing.two,
  },
  input: {
    minHeight: 36,
    maxHeight: 120,
    paddingVertical: Spacing.two,
    fontSize: 16,
  },
});
