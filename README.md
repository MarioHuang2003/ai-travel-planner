# 说走就走 · AI 旅行 Timeline 规划器

一句话描述你想去哪，AI 帮你生成可视化时间线行程：含景点、美食、交通、避坑指南，可微调、可保存为长图。

## 主要功能

- **一句话生成行程**：兼容 OpenAI 协议的 LLM（智谱 GLM、DeepSeek、Kimi、OpenAI…）输出多日时间线
- **地图与路线**：接入高德 JS API，每天独立地图、节点定位、步行 / 骑行 / 公交 / 驾车 / 打车 五种交通方式
- **多步撤销 / 重做**：⌘Z / ⌘⇧Z 全局快捷键，所有修改可回溯
- **多节点修改**：支持单点、多选、整日、整次行程的批量调整，并自动联动相邻节点的时间安排
- **POI 探索面板**：按城市浏览景点 / 美食 / 住宿，或直接搜索地点（如「华东师范大学」），一键插入或替换行程节点
- **AI 推荐缓存**：会话内缓存推荐结果，避免重复 token 消耗
- **保存长图**：一键导出整个行程为长图分享

## 快速开始

```bash
# 1. 安装依赖
npm install

# 2. 复制环境变量并填入你的 Key
cp .env.example .env.local

# 3. 本地开发
npm run dev

# 4. 生产构建
npm run build
```

## 必填环境变量

| 变量 | 说明 |
| --- | --- |
| `VITE_LLM_BASE_URL` | LLM 端点（OpenAI 兼容协议） |
| `VITE_LLM_API_KEY` | LLM API Key |
| `VITE_LLM_MODEL` | 模型名称（推荐 `glm-5.1`，内置联网搜索） |

## 可选环境变量

| 变量 | 说明 |
| --- | --- |
| `VITE_AMAP_KEY` | 高德 JS API Key，配置后激活地图与路线规划 |
| `VITE_AMAP_SECURITY_CODE` | 高德安全密钥（jscode） |
| `VITE_LLM_DISABLE_WEB_SEARCH` | 设为 `1` 关闭联网搜索 |

详细申请步骤见 `.env.example`。

## 技术栈

Vue 3 + TypeScript + Vite + Pinia + Element Plus + 高德 JS API
