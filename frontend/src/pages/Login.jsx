import React, { useState } from 'react';
import { Alert, Button, Form, InputGroup } from 'react-bootstrap';
import { useAuth } from '../auth.jsx';

const NAME_REGEX = /^[A-Za-z\s.'-]+$/;
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export default function Login() {
  const { login, register } = useAuth();
  const [mode, setMode] = useState('login');
  const [f, setF] = useState({ name: '', email: '', password: '' });
  const [touched, setTouched] = useState({ name: false, email: false, password: false });
  const [showPassword, setShowPassword] = useState(false);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  const setField = (k) => (e) => setF({ ...f, [k]: e.target.value });
  const markTouched = (k) => () => setTouched((prev) => ({ ...prev, [k]: true }));

  // Live validation checks
  const nameTrimmed = f.name.trim();
  const isNameFormatValid = NAME_REGEX.test(nameTrimmed);
  const isNameValid = nameTrimmed.length >= 2 && isNameFormatValid;
  const isNameInvalid = touched.name && !isNameValid;

  const emailTrimmed = f.email.trim();
  const isEmailValid = EMAIL_REGEX.test(emailTrimmed);
  const isEmailInvalid = touched.email && !isEmailValid;

  const isPasswordValid = mode === 'register' ? f.password.length >= 8 && f.password.length <= 72 : f.password.length > 0;
  const isPasswordInvalid = touched.password && !isPasswordValid;

  const isFormValid = mode === 'register'
    ? isNameValid && isEmailValid && isPasswordValid
    : isEmailValid && isPasswordValid;

  const switchMode = (newMode) => {
    setMode(newMode);
    setErr('');
    setTouched({ name: false, email: false, password: false });
  };

  const submit = async (e) => {
    e.preventDefault();
    setTouched({ name: true, email: true, password: true });
    if (!isFormValid) return;
    setErr('');
    setBusy(true);
    try {
      if (mode === 'login') {
        await login(emailTrimmed, f.password);
      } else {
        await register(nameTrimmed, emailTrimmed, f.password);
      }
    } catch (ex) {
      setErr(ex.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="ns-login ns-card p-4">
      <h3 className="mb-1">NetSwitch</h3>
      <p className="ns-muted">Multi-Interface Network Telemetry, Selection &amp; Route Failover</p>

      {mode === 'register' && (
        <Alert variant="info" className="py-2 small">
          <b>Role Notice:</b> The first account created receives the <b>Admin</b> role. Any subsequent account receives <b>Viewer</b> (read-only) privileges.
        </Alert>
      )}

      {err && <Alert variant="danger" className="py-2 small">{err}</Alert>}

      <Form onSubmit={submit} noValidate>
        {mode === 'register' && (
          <Form.Group className="mb-3">
            <Form.Label className="small fw-semibold">Full Name</Form.Label>
            <Form.Control
              value={f.name}
              onChange={setField('name')}
              onBlur={markTouched('name')}
              placeholder="e.g. Tanmay Sharma"
              required
              maxLength={100}
              isValid={touched.name && isNameValid}
              isInvalid={isNameInvalid}
            />
            {isNameInvalid && (
              <Form.Control.Feedback type="invalid" className="small">
                {nameTrimmed.length === 0
                  ? 'Name is required.'
                  : !isNameFormatValid
                    ? 'Name can only contain letters and spaces (no numbers or special characters).'
                    : 'Name must be at least 2 characters long.'}
              </Form.Control.Feedback>
            )}
            {touched.name && isNameValid && (
              <Form.Control.Feedback type="valid" className="small">
                ✓ Valid name format
              </Form.Control.Feedback>
            )}
          </Form.Group>
        )}

        <Form.Group className="mb-3">
          <Form.Label className="small fw-semibold">Email Address</Form.Label>
          <Form.Control
            type="email"
            value={f.email}
            onChange={setField('email')}
            onBlur={markTouched('email')}
            placeholder="admin@netswitch.local"
            required
            autoComplete="username"
            isValid={touched.email && isEmailValid}
            isInvalid={isEmailInvalid}
          />
          {isEmailInvalid && (
            <Form.Control.Feedback type="invalid" className="small">
              {emailTrimmed.length === 0
                ? 'Email address is required.'
                : 'Please enter a valid email address (e.g. user@example.com).'}
            </Form.Control.Feedback>
          )}
          {touched.email && isEmailValid && (
            <Form.Control.Feedback type="valid" className="small">
              ✓ Valid email format
            </Form.Control.Feedback>
          )}
        </Form.Group>

        <Form.Group className="mb-3">
          <Form.Label className="small fw-semibold">Password</Form.Label>
          <InputGroup hasValidation>
            <Form.Control
              type={showPassword ? 'text' : 'password'}
              value={f.password}
              onChange={setField('password')}
              onBlur={markTouched('password')}
              placeholder="••••••••"
              required
              minLength={8}
              maxLength={72}
              autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
              isValid={touched.password && isPasswordValid}
              isInvalid={isPasswordInvalid}
            />
            <Button
              variant="outline-secondary"
              type="button"
              onClick={() => setShowPassword(!showPassword)}
              title={showPassword ? 'Hide password' : 'Show password'}
              style={{ minWidth: 64 }}
            >
              {showPassword ? 'Hide' : 'Show'}
            </Button>
            {isPasswordInvalid && (
              <Form.Control.Feedback type="invalid" className="small">
                {mode === 'register'
                  ? `Password must be at least 8 characters long (${f.password.length}/8 entered).`
                  : 'Password is required.'}
              </Form.Control.Feedback>
            )}
            {touched.password && isPasswordValid && mode === 'register' && (
              <Form.Control.Feedback type="valid" className="small">
                ✓ Password meets length requirement ({f.password.length} characters)
              </Form.Control.Feedback>
            )}
          </InputGroup>
          {mode === 'register' && !touched.password && (
            <Form.Text className="text-muted small">8 to 72 characters.</Form.Text>
          )}
        </Form.Group>

        <Button
          type="submit"
          className="w-100 mt-2"
          disabled={busy || (Object.values(touched).some(Boolean) && !isFormValid)}
        >
          {busy ? 'Please wait…' : (mode === 'login' ? 'Sign In' : 'Create Account')}
        </Button>
      </Form>

      <div className="text-center mt-3 small">
        {mode === 'login' ? (
          <>
            Don't have an account?{' '}
            <a href="#r" onClick={(e) => { e.preventDefault(); switchMode('register'); }}>
              Register
            </a>
          </>
        ) : (
          <>
            Already have an account?{' '}
            <a href="#l" onClick={(e) => { e.preventDefault(); switchMode('login'); }}>
              Sign In
            </a>
          </>
        )}
      </div>
    </div>
  );
}
