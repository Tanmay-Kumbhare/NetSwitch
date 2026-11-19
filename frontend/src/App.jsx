import React from 'react';
import { Navigate, NavLink, Route, Routes } from 'react-router-dom';
import { Container, Nav, Navbar, Spinner } from 'react-bootstrap';
import { useAuth } from './auth.jsx';
import { useLive } from './live.jsx';
import Toasts from './components/Toasts.jsx';
import Login from './pages/Login.jsx';
import Dashboard from './pages/Dashboard.jsx';
import History from './pages/History.jsx';
import Control from './pages/Control.jsx';
import InterfaceDetail from './pages/InterfaceDetail.jsx';
import Learn from './pages/Learn.jsx';

function Shell({ children }) {
  const { user, logout } = useAuth();
  const { status, pingMs, hello } = useLive();
  return (
    <>
      <Navbar expand="md" className="ns-nav" variant="dark">
        <Container>
          <Navbar.Brand>NetSwitch</Navbar.Brand>
          <Navbar.Toggle />
          <Navbar.Collapse>
            <Nav className="me-auto">
              {[['/', 'Dashboard'], ['/history', 'History'], ['/control', 'Control'], ['/learn', 'Learn']].map(([to, label]) => (
                <Nav.Link key={to} as={NavLink} to={to} end={to === '/'}>{label}</Nav.Link>
              ))}
            </Nav>
            <span className={`ns-pill me-3 ${status === 'open' ? 'ok' : 'bad'}`} title="WebSocket connection">WS {status}{pingMs != null && status === 'open' ? ` · ${pingMs} ms` : ''}</span>
            {hello && <span className={`ns-pill me-3 ${hello.mode === 'sim' ? 'sim' : 'live'}`}>{hello.mode === 'sim' ? 'SIMULATION' : 'LIVE · Windows'}</span>}
            <span className="text-light me-3 small">{user.name} ({user.role})</span>
            <button className="btn btn-sm btn-outline-light" onClick={logout}>Log out</button>
          </Navbar.Collapse>
        </Container>
      </Navbar>
      <Container className="py-4">{children}</Container>
      <Toasts />
    </>
  );
}

export default function App() {
  const { user, ready } = useAuth();
  if (!ready) return <div className="text-center mt-5"><Spinner /></div>;
  if (!user) return <Routes><Route path="*" element={<Login />} /></Routes>;
  return (
    <Shell>
      <Routes>
        <Route path="/" element={<Dashboard />} />
        <Route path="/history" element={<History />} />
        <Route path="/control" element={<Control />} />
        <Route path="/interfaces/:key" element={<InterfaceDetail />} />
        <Route path="/learn" element={<Learn />} />
        <Route path="*" element={<Navigate to="/" />} />
      </Routes>
    </Shell>
  );
}
