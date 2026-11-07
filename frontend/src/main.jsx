import React from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import 'bootstrap/dist/css/bootstrap.min.css';
import './styles.css';
import App from './App.jsx';
import { AuthProvider } from './auth.jsx';
import { LiveProvider } from './live.jsx';

createRoot(document.getElementById('root')).render(
  <BrowserRouter>
    <AuthProvider>
      <LiveProvider>
        <App />
      </LiveProvider>
    </AuthProvider>
  </BrowserRouter>,
);
