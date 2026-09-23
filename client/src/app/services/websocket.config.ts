// Centralized WebSocket configuration
export const WEBSOCKET_CONFIG = {
  HEARTBEAT_INTERVAL_MS: 15000,
  /**
   * How long the client keeps trying, and therefore how long an outage a
   * game can survive. Each attempt costs the handshake timeout (3s, in the
   * service) plus this wait jittered up to 1.5x, so five of them span
   * roughly 30-37s.
   *
   * That has to stay at or above the server's DISCONNECT_GRACE_SECONDS (30):
   * the server forfeits a missing player at 30 seconds whatever the client
   * does, so a client that gave up sooner would lose games it was still in a
   * position to save. Lowering either of these without the other is how that
   * happens.
   */
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
