import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './global.css';
import { App } from './App';
import { installCodeCopy } from './codeCopy';

installCodeCopy();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
