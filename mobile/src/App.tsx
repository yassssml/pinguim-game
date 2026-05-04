import React, { useEffect } from 'react';
import { Platform } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import * as ScreenOrientation from 'expo-screen-orientation';
import * as SplashScreen from 'expo-splash-screen';
import GameScreen from './screens/GameScreen';

// Mantém o splash screen visível até o app estar pronto
SplashScreen.preventAutoHideAsync();

export default function App() {
  useEffect(() => {
    async function prepare() {
      try {
        // Força landscape em dispositivos móveis (melhor para o gameplay)
        if (Platform.OS !== 'web') {
          await ScreenOrientation.lockAsync(
            ScreenOrientation.OrientationLock.LANDSCAPE
          );
        }
      } catch (e) {
        // Orientação não crítica — ignora silenciosamente
        console.warn('Orientação não suportada neste dispositivo.');
      } finally {
        // Esconde o splash screen nativo
        await SplashScreen.hideAsync();
      }
    }

    prepare();
  }, []);

  return (
    <SafeAreaProvider>
      <GameScreen />
    </SafeAreaProvider>
  );
}
