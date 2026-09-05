// Centralized WebSocket configuration
export const WEBSOCKET_CONFIG = {
  HEARTBEAT_INTERVAL_MS: 15000,
  RECONNECT_INTERVAL_MS: 3000,
  MAX_RECONNECT_ATTEMPTS: 5,
  /**
   * Where `ng serve` runs. It proxies nothing, so a page served from this
   * port is the one case where the socket has to be pointed somewhere else -
   * see createSocket. Anywhere else the page's own origin answers.
   */
  DEV_SERVER_PORT: '4200',
  BACKEND_PORT: 8000,
};
