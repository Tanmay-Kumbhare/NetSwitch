import React, { createContext, useContext, useEffect, useState, useCallback } from 'react';
import { api, setToken, getToken } from './api.js';

const Ctx = createContext(null);
export const useAuth = () => useContext(Ctx);

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [ready, setReady] = useState(!getToken());
  useEffect(() => {
    if (!getToken()) return;
    api('/api/auth/me').then(setUser).catch(() => setToken('')).finally(() => setReady(true));
  }, []);
  const login = useCallback(async (email, password) => { const r = await api('/api/auth/login', { method: 'POST', body: { email, password } }); setToken(r.token); setUser(r.user); }, []);
  const register = useCallback(async (name, email, password) => { const r = await api('/api/auth/register', { method: 'POST', body: { name, email, password } }); setToken(r.token); setUser(r.user); }, []);
  const logout = useCallback(() => { setToken(''); setUser(null); }, []);
  return <Ctx.Provider value={{ user, ready, login, register, logout }}>{children}</Ctx.Provider>;
}
