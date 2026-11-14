/**
 * openclaw-fnos panel entry point. One Node server on one unix socket
 * serves the JSON API, the static UI, and the gateway console proxy.
 */

import { startPanel } from './src/server.js';

startPanel();
