import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.tsx';
import './index.css';
import { applyTheme, readTheme } from './lib/theme';

// Before React mounts: a dark phone must not get a white flash first.
applyTheme(readTheme());

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>
);
