import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    // 5174 so this can run alongside the admin app on 5173.
    port: 5174,
    proxy: {
      // Same single-origin trick as admin: /api is proxied to the API server,
      // so the browser never makes a cross-origin request and CORS stays out
      // of the picture during dev.
      '/api': {
        target: 'http://localhost:3000',
        changeOrigin: true,
      },
    },
    // LIFF requires an HTTPS endpoint reachable from LINE's servers, so dev is
    // normally done through a tunnel (ngrok, cloudflared). Tunnels arrive with
    // a hostname Vite does not know, and it rejects unknown Host headers.
    allowedHosts: true,
  },
})
