import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.munchmatch.app',
  appName: 'MunchMatch',
  webDir: 'dist',
  // Deliberately no `server.url` — the native shells run the bundled
  // dist/ output, never the live Firebase Hosting site. No cleartext
  // traffic exception and no navigation allowlist beyond Capacitor's
  // own defaults (the app only ever talks to Firebase over HTTPS).
};

export default config;
