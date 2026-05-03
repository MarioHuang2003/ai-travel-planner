import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

// GitHub Pages 部署到子路径 /ai-travel-planner/，
// 静态资源必须带这个前缀才能加载到。
// 本地 dev 时 base 应当是 '/'，所以只在 build 模式下注入。
export default defineConfig(({ command }) => ({
  base: command === 'build' ? '/ai-travel-planner/' : '/',
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
}))
