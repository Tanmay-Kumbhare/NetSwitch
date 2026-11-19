import React, { useState } from 'react';
import { Alert, Button, Form } from 'react-bootstrap';
import { useAuth } from '../auth.jsx';

export default function Login() {
  const { login, register } = useAuth();
  const [mode, setMode] = useState('login');
  const [f, setF] = useState({ name: '', email: '', password: '' });
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  const submit = async (e) => {
    e.preventDefault(); setErr(''); setBusy(true);
    try { mode === 'login' ? await login(f.email, f.password) : await register(f.name, f.email, f.password); }
    catch (ex) { setErr(ex.message); } finally { setBusy(false); }
  };
  return (
    <div className="ns-login ns-card p-4">
      <h3 className="mb-1">NetSwitch</h3>
      <p className="ns-muted">Multi-Interface Network Telemetry, Selection &amp; Route Failover</p>
      {mode === 'register' && <Alert variant="info" className="py-2 small">The first account created receives the Admin role with adapter control privileges.</Alert>}
      {err && <Alert variant="danger" className="py-2">{err}</Alert>}
      <Form onSubmit={submit}>
        {mode === 'register' && <Form.Group className="mb-3"><Form.Label>Name</Form.Label><Form.Control value={f.name} onChange={set('name')} required maxLength={100} /></Form.Group>}
        <Form.Group className="mb-3"><Form.Label>Email Address</Form.Label><Form.Control type="email" value={f.email} onChange={set('email')} required autoComplete="username" /></Form.Group>
        <Form.Group className="mb-3"><Form.Label>Password</Form.Label><Form.Control type="password" value={f.password} onChange={set('password')} required minLength={8} maxLength={72} autoComplete={mode === 'login' ? 'current-password' : 'new-password'} />{mode === 'register' && <Form.Text>8 to 72 characters.</Form.Text>}</Form.Group>
        <Button type="submit" className="w-100" disabled={busy}>{mode === 'login' ? 'Sign In' : 'Create Account'}</Button>
      </Form>
      <div className="text-center mt-3 small">
        {mode === 'login' ? <>Don't have an account? <a href="#r" onClick={(e) => { e.preventDefault(); setMode('register'); }}>Register</a></> : <>Already have an account? <a href="#l" onClick={(e) => { e.preventDefault(); setMode('login'); }}>Sign In</a></>}
      </div>
    </div>
  );
}
