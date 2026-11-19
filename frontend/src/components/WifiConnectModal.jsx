import React from 'react';
import { Alert, Button, Modal, Spinner } from 'react-bootstrap';

export default function WifiConnectModal({ show, onHide, profile, onConfirm, connecting, error }) {
  return (
    <Modal show={show} onHide={connecting ? undefined : onHide} centered>
      <Modal.Header closeButton={!connecting}>
        <Modal.Title className="h6 fw-bold mb-0">Confirm Wi-Fi Connection</Modal.Title>
      </Modal.Header>
      <Modal.Body>
        <p className="mb-2">
          Connect to Wi-Fi profile <strong className="text-primary">{profile}</strong>?
        </p>
        <Alert variant="warning" className="small mb-2 py-2">
          <strong>Notice:</strong> Switching Wi-Fi networks causes a momentary wireless drop while Windows associates with the new access point and acquires a DHCP lease. Active TCP connections using this Wi-Fi adapter will temporarily disconnect.
        </Alert>
        <p className="small text-muted mb-0">
          NetSwitch executes <code>netsh wlan connect</code> only for saved Windows profiles. This action is never automatic.
        </p>
        {error && <Alert variant="danger" className="small mt-2 py-1 mb-0">{error}</Alert>}
      </Modal.Body>
      <Modal.Footer>
        <Button variant="secondary" size="sm" onClick={onHide} disabled={connecting}>
          Cancel
        </Button>
        <Button variant="primary" size="sm" onClick={onConfirm} disabled={connecting}>
          {connecting ? (
            <>
              <Spinner animation="border" size="sm" className="me-1" />
              Connecting…
            </>
          ) : (
            'Confirm & Connect'
          )}
        </Button>
      </Modal.Footer>
    </Modal>
  );
}
