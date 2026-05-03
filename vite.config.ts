import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

export default defineConfig({
  plugins: [vue()],
  server: {
    port: 5173,
    open: false,
  },
  optimizeDeps: {
    include: [
      'vue',
      'pinia',
      'axios',
      'element-plus',
      'element-plus/es',
      '@element-plus/icons-vue',
      'html2canvas',
      'file-saver',
      '@amap/amap-jsapi-loader',
    ],
  },
})
