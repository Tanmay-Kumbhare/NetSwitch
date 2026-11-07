-- NetSwitch schema (MySQL 8 / MariaDB 10.6+). Five tables.
CREATE TABLE IF NOT EXISTS users (
  id            INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  email         VARCHAR(190) NOT NULL UNIQUE,
  name          VARCHAR(100) NOT NULL,
  password_hash VARCHAR(100) NOT NULL,
  role          ENUM('admin','viewer') NOT NULL DEFAULT 'viewer',
  created_at    TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS interfaces (
  id          INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  adapter_key VARCHAR(40) NOT NULL UNIQUE,          -- 'wifi', 'usb', ...
  alias       VARCHAR(100) NOT NULL,
  kind        ENUM('wifi','usb','other') NOT NULL,
  if_index    INT NOT NULL,
  ipv4        VARCHAR(15) NOT NULL,
  gateway     VARCHAR(15) NOT NULL,
  first_seen  DATETIME(3) NOT NULL,
  last_seen   DATETIME(3) NOT NULL
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS readings (
  id           BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  interface_id INT UNSIGNED NOT NULL,
  ts           DATETIME(3) NOT NULL,
  score        DECIMAL(5,1) NULL,
  loss_pct     DECIMAL(5,1) NULL,
  rtt_ms       DECIMAL(8,2) NULL,
  jitter_ms    DECIMAL(8,2) NULL,
  tcp_ms       DECIMAL(8,2) NULL,
  state        VARCHAR(20) NOT NULL,                -- healthy | degraded | unhealthy | unverified | down
  INDEX idx_readings_iface_ts (interface_id, ts),
  CONSTRAINT fk_readings_iface FOREIGN KEY (interface_id) REFERENCES interfaces(id) ON DELETE CASCADE
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS failover_events (
  id         BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  ts         DATETIME(3) NOT NULL,
  from_key   VARCHAR(40) NOT NULL,
  to_key     VARCHAR(40) NOT NULL,
  reason     ENUM('adapter_down','hard_failure','degradation','switch_back','manual') NOT NULL,
  detect_ms  INT NULL,                              -- first lost probe -> decision
  switch_ms  INT NULL,                              -- decision -> verified switch
  total_ms   INT NULL,                              -- first lost probe -> verified
  success    TINYINT(1) NOT NULL,
  note       VARCHAR(255) NOT NULL DEFAULT '',
  INDEX idx_failover_ts (ts)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS config (
  k VARCHAR(40) PRIMARY KEY,
  v JSON NOT NULL,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB;
