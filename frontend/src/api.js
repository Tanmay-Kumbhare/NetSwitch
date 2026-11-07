let token = localStorage.getItem('ns_token') || '';
export const getToken = () => token;
export const setToken = (t) => { token = t || ''; try { t ? localStorage.setItem('ns_token', t) : localStorage.removeItem('ns_token'); } catch { /* storage unavailable */ } };

export async function api(path, { method = 'GET', body } = {}) {
  const r = await fetch(path, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) { const e = new Error(data.error || data.note || `HTTP ${r.status}`); e.status = r.status; e.data = data; throw e; }
  return data;
}
