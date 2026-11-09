// Local-only browser test targets. Test runs start the bundled relay and a
// dedicated dev server; they never contact the public signaling endpoint.
export const APP_URL = 'http://localhost:5174';
export const LOCAL_RELAY_URL = 'ws://127.0.0.1:4444';
