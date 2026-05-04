import React, { useRef, useState, useCallback } from 'react';
import {
  StyleSheet,
  View,
  Text,
  ActivityIndicator,
  TouchableOpacity,
  StatusBar,
  Platform,
  Animated,
} from 'react-native';
import { WebView, WebViewNavigation } from 'react-native-webview';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import SERVER_URL from '../config';

// ─── Script injetado na WebView para melhorar o comportamento mobile ────────
// Remove o zoom duplo-clique, previne pull-to-refresh e desativa o scroll
const INJECTED_JS = `
  (function() {
    // Desativa duplo-toque para zoom
    var lastTouchEnd = 0;
    document.addEventListener('touchend', function(e) {
      var now = Date.now();
      if (now - lastTouchEnd <= 300) e.preventDefault();
      lastTouchEnd = now;
    }, { passive: false });

    // Desativa pull-to-refresh e scroll indesejado
    document.body.style.overscrollBehavior = 'none';
    document.documentElement.style.overscrollBehavior = 'none';

    // Garante que tela fique em landscape (hint para o navegador embutido)
    if (screen.orientation && screen.orientation.lock) {
      screen.orientation.lock('landscape').catch(() => {});
    }

    true; // obrigatório para Android
  })();
`;

type LoadState = 'loading' | 'loaded' | 'error';

export default function GameScreen() {
  const insets = useSafeAreaInsets();
  const webViewRef = useRef<WebView>(null);
  const [loadState, setLoadState] = useState<LoadState>('loading');
  const [fadeAnim] = useState(new Animated.Value(1));
  const [errorMsg, setErrorMsg] = useState('');

  // Quando o jogo termina de carregar → fade-out na tela de loading
  const handleLoadEnd = useCallback(() => {
    Animated.timing(fadeAnim, {
      toValue: 0,
      duration: 600,
      useNativeDriver: true,
    }).start(() => setLoadState('loaded'));
  }, [fadeAnim]);

  const handleError = useCallback((e: any) => {
    const desc = e?.nativeEvent?.description || '';
    setErrorMsg(desc || 'Não foi possível conectar ao servidor.');
    setLoadState('error');
  }, []);

  const handleRetry = useCallback(() => {
    setLoadState('loading');
    fadeAnim.setValue(1);
    setErrorMsg('');
    webViewRef.current?.reload();
  }, [fadeAnim]);

  return (
    <View style={styles.container}>
      <StatusBar hidden />

      {/* ── WebView principal ── */}
      <WebView
        ref={webViewRef}
        style={styles.webview}
        source={{ uri: SERVER_URL }}
        injectedJavaScript={INJECTED_JS}
        // Eventos de carga
        onLoadEnd={handleLoadEnd}
        onError={handleError}
        onHttpError={handleError}
        // Performance & compatibilidade
        javaScriptEnabled
        domStorageEnabled           // localStorage do jogo (saves, skins)
        allowsInlineMediaPlayback
        mediaPlaybackRequiresUserAction={false}
        scrollEnabled={false}       // o jogo controla seu próprio scroll/câmera
        bounces={false}
        overScrollMode="never"
        // iOS: permite fullscreen canvas
        allowsFullscreenVideo
        // Mantém estado ao ir para segundo plano
        cacheEnabled
        // User-Agent mobile para forçar viewport correto
        applicationNameForUserAgent="PenguinKnockout/1.0"
      />

      {/* ── Tela de Loading (fade-out automático) ── */}
      {loadState !== 'loaded' && loadState !== 'error' && (
        <Animated.View style={[styles.overlay, { opacity: fadeAnim }]}>
          <View style={styles.loadingBox}>
            <Text style={styles.emoji}>🐧</Text>
            <Text style={styles.loadingTitle}>PENGUIN KNOCKOUT</Text>
            <ActivityIndicator
              size="large"
              color="#00f2ff"
              style={{ marginTop: 20 }}
            />
            <Text style={styles.loadingSubtitle}>Conectando ao servidor...</Text>
          </View>
        </Animated.View>
      )}

      {/* ── Tela de Erro (servidor offline) ── */}
      {loadState === 'error' && (
        <View style={styles.overlay}>
          <View style={styles.errorBox}>
            <Text style={styles.emoji}>❌</Text>
            <Text style={styles.errorTitle}>Servidor Offline</Text>
            <Text style={styles.errorBody}>
              Inicie o servidor com:{'\n'}
              <Text style={styles.code}>node server.js</Text>
              {'\n\n'}
              {errorMsg ? `Detalhe: ${errorMsg}` : ''}
              {'\n\n'}
              URL configurada:{'\n'}
              <Text style={styles.code}>{SERVER_URL}</Text>
            </Text>
            <TouchableOpacity style={styles.retryBtn} onPress={handleRetry}>
              <Text style={styles.retryText}>TENTAR NOVAMENTE</Text>
            </TouchableOpacity>
          </View>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#000',
  },
  webview: {
    flex: 1,
    backgroundColor: '#a2d2ff',
  },

  // ── Overlay (Loading / Error) ──────────────────────────────────────────────
  overlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: '#0a1628',
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 99,
  },

  // ── Loading ────────────────────────────────────────────────────────────────
  loadingBox: {
    alignItems: 'center',
    paddingHorizontal: 40,
  },
  emoji: {
    fontSize: 72,
    marginBottom: 12,
  },
  loadingTitle: {
    fontSize: 32,
    fontWeight: '900',
    color: '#ffffff',
    letterSpacing: 4,
    textAlign: 'center',
    textShadowColor: '#00f2ff',
    textShadowOffset: { width: 0, height: 0 },
    textShadowRadius: 20,
  },
  loadingSubtitle: {
    marginTop: 14,
    fontSize: 15,
    color: '#88aacc',
    letterSpacing: 1,
  },

  // ── Error ──────────────────────────────────────────────────────────────────
  errorBox: {
    alignItems: 'center',
    backgroundColor: '#122040',
    borderRadius: 24,
    padding: 36,
    margin: 24,
    borderWidth: 2,
    borderColor: '#ff4757',
    maxWidth: 480,
  },
  errorTitle: {
    fontSize: 26,
    fontWeight: '800',
    color: '#ff4757',
    marginBottom: 16,
  },
  errorBody: {
    fontSize: 14,
    color: '#aabdd0',
    textAlign: 'center',
    lineHeight: 22,
  },
  code: {
    fontFamily: Platform.OS === 'ios' ? 'Courier New' : 'monospace',
    color: '#00f2ff',
    fontSize: 13,
  },
  retryBtn: {
    marginTop: 28,
    backgroundColor: '#00f2ff',
    paddingVertical: 14,
    paddingHorizontal: 36,
    borderRadius: 50,
  },
  retryText: {
    color: '#0a1628',
    fontWeight: '900',
    fontSize: 16,
    letterSpacing: 2,
  },
});
