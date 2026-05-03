import { createApp } from 'vue'
import type { Component } from 'vue'
import { createPinia } from 'pinia'
import ElementPlus from 'element-plus'
import * as ElementPlusIconsVue from '@element-plus/icons-vue'
import 'element-plus/dist/index.css'

import './style.css'
import App from './App.vue'

const app = createApp(App)

const icons = ElementPlusIconsVue as Record<string, Component>
for (const key in icons) {
  app.component(key, icons[key])
}

app.use(createPinia())
app.use(ElementPlus)
app.mount('#app')
