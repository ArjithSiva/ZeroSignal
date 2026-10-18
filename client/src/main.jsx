import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { Toaster } from 'sonner';
import App from './App.jsx';
import { AuthProvider } from './context/AuthContext.jsx';
import { initPrefs } from './lib/prefs.js';
import { initTheme, useTheme } from './lib/theme.js';
import ThemeSync from './components/ThemeSync.jsx';
import './index.css';

initPrefs();
initTheme();

function ThemedToaster() {
  const { resolved } = useTheme();
  return <Toaster theme={resolved} position="top-right" richColors closeButton />;
}

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <BrowserRouter>
      <AuthProvider>
        <ThemeSync />
        <App />
        <ThemedToaster />
      </AuthProvider>
    </BrowserRouter>
  </StrictMode>,
);

// Offline shell + cached public key (production only; a dev service worker just gets in the way).
if ('serviceWorker' in navigator && import.meta.env.PROD) {
  window.addEventListener('load', () => navigator.serviceWorker.register('/sw.js').catch(() => {}));
}
