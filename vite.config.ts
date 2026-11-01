import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/api/store': {
        target: 'https://wehliye-store-v8.onrender.com',
        changeOrigin: true,
        secure: true
      },
      '/api': 'http://localhost:3001',
      '/admin': 'http://localhost:3001'
    }
  }
});
