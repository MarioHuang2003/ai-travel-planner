# 说走就走 · AI 旅行 Timeline 规划器

一句话描述你想去哪，AI 帮你生成可视化时间线行程：景点、美食、住宿、交通、避坑指南一应俱全，全程可微调、可保存为长图分享。

🌐 **在线体验**：<https://mariohuang2003.github.io/ai-travel-planner/>
📦 **GitHub 仓库**：<https://github.com/MarioHuang2003/ai-travel-planner>

> **技术栈**：Vue 3 + TypeScript + Vite + Pinia + Element Plus + 高德 JS API
> **LLM**：兼容 OpenAI 协议的任意端点（智谱 GLM、DeepSeek、Kimi、OpenAI…）

---

## 目录

- [核心特性](#核心特性)
- [快速开始](#快速开始)
- [环境变量](#环境变量)
- [项目结构](#项目结构)
- [使用指南](#使用指南)
- [快捷键](#快捷键)
- [LLM 提示词与模型选择](#llm-提示词与模型选择)
- [高德地图集成](#高德地图集成)
- [数据持久化](#数据持久化)
- [构建与部署](#构建与部署)
- [已知限制](#已知限制)

---

## 核心特性

### 一句话生成行程
- 自然语言描述需求 → LLM 输出多日时间线 JSON（含景点、餐饮、住宿、长途交通）
- 内置 6 个示例预设（成都美食、京都赏樱、新疆 7 天等），点击即填
- 流式 / 非流式自动适配，请求可随时取消（`Esc` 或界面按钮）
- 每个节点带 **完整结构化地址**、**真实游玩时长**、**人均花费**、**避坑 tips**

### 时间线可视化
- 按天分组，节点按时间顺序排列；类型用色块区分（景点 · 餐饮 · 住宿 · 长途交通）
- 节点间自动展示 **路线段（RouteSegment）**：步行 / 骑行 / 公交 / 驾车 / 打车 五种交通方式可一键切换
- 支持总览：游玩总时长、餐饮门票住宿合计、交通估算合计

### 多步撤销 / 重做（P1）
- 全局快捷键 `⌘Z` / `⌘⇧Z`（macOS）或 `Ctrl+Z` / `Ctrl+Shift+Z`（Win）
- 撤销栈深度 20，自动持久化到 localStorage，刷新不丢
- 历史记录单独维护：每次成功生成留一份快照，可一键切换、删除

### 多节点 / 整日 / 整体修改（P2）
- **单节点修改**：鼠标悬停任意节点点"调"按钮
- **批量修改**：进入批量选择模式，勾选若干节点统一调整
- **整日重排**：每天右上角"改这一整天"
- **整体重排**：toolbar 的"重排整体"，可让 AI 重排全部天数 / 节点 / 预算
- 每种 scope 提供贴合场景的具体示例 placeholder

### 联动调整（P3）
- 修改一个节点时，AI 会顺手调整相邻时间冲突的节点
- 被联动的节点会以"已联动"高亮 6 秒，并在 toolbar 提示"主改 X 项 + 联动 Y 项 · ⌘Z 撤销"
- 撤销 / 重做 / 切换历史时联动高亮自动清空

### POI 探索面板（P4）
- 侧边面板浏览目的地的 **景点 / 美食 / 住宿**
- 双数据源：
  - **高德全量**：高德 PlaceSearch 实时检索，结果多、可翻页
  - **AI 精选**：让 LLM 联网精选 8 条，带停留时长 + 避坑 tips
- **关键词直搜**：输入"华东师范大学""外滩"等具体地名，跨城精准定位
- POI 卡内嵌 **Mini Map**（IntersectionObserver 懒加载，不阻塞列表滚动）
- **AI 推荐缓存**：会话内按"城市 + 类别 + 当前行程指纹"缓存，避免重复 token 消耗；行程一改自动失效

### 一键插入 / 替换
- 探索面板任意 POI → "插入"或"替换"行程节点
- 插入时调用 LLM 顺手重排临近节点时间，避免冲突
- 替换同样支持联动调整

### 保存为长图
- 调 html2canvas 把整个截图区域导出 PNG
- 自动隐藏 toolbar / 编辑按钮 / 黑板提示等不该入图的元素
- 包含 trip 标题 + summary + 每天 timeline + 路线段 + 预算汇总

---

## 快速开始

```bash
# 1. 安装依赖
npm install

# 2. 复制环境变量并填入你的 Key
cp .env.example .env.local
# 编辑 .env.local，至少填好 VITE_LLM_API_KEY

# 3. 本地开发（默认 http://localhost:5173）
npm run dev

# 4. 生产构建
npm run build

# 5. 本地预览构建产物
npm run preview
```

无 LLM Key 时启动会失败；无高德 Key 时启动正常，但所有地图相关功能会以"友好降级"形式关闭（不会报错）。

---

## 环境变量

所有变量都以 `VITE_` 前缀，编译时注入到客户端。

### 必填

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `VITE_LLM_API_KEY` | — | 兼容 OpenAI 协议的 LLM API Key |

### LLM 配置

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `VITE_LLM_BASE_URL` | 智谱端点 | LLM Chat Completions 端点 |
| `VITE_LLM_MODEL` | `glm-5.1` | 模型名称 |
| `VITE_LLM_DISABLE_WEB_SEARCH` | `0` | 设为 `1` 关闭联网搜索（端点不支持时） |

支持的端点示例：

```
智谱     https://open.bigmodel.cn/api/paas/v4/chat/completions
DeepSeek https://api.deepseek.com/chat/completions
Kimi     https://api.moonshot.cn/v1/chat/completions
OpenAI   https://api.openai.com/v1/chat/completions
```

### 高德地图（可选，不填则地图功能降级）

| 变量 | 说明 |
| --- | --- |
| `VITE_AMAP_KEY` | 高德 JS API Key |
| `VITE_AMAP_SECURITY_CODE` | 高德安全密钥（jscode） |

申请流程：

1. 访问 [高德开放平台控制台](https://console.amap.com/dev/key/app)，注册 + 实名（个人免费）
2. **应用管理 → 创建新应用 → 添加 Key**
3. 服务平台选择 **Web 端 (JS API)**
4. 复制生成的 `Key` 填入 `VITE_AMAP_KEY`
5. 复制 `安全密钥(jscode)` 填入 `VITE_AMAP_SECURITY_CODE`

> ⚠️ 高德新版 JS API 要求把 `securityJsCode` 写在前端，本项目按此实现。生产环境请通过自建代理转发以避免 Key 泄露；上线后绑定域名白名单。

---

## 项目结构

```
ai-travel-planner/
├── public/
│   └── favicon.svg                   品牌图标
├── src/
│   ├── api/
│   │   ├── llmService.ts             LLM 通信：生成 / 修改 / 探索推荐
│   │   └── amapService.ts            高德 API：地理编码、路径规划、POI 检索
│   ├── components/
│   │   ├── DayMap.vue                单日地图：节点 marker + 路径绘制
│   │   ├── RouteSegment.vue          相邻节点之间的路线段卡片（5 种交通方式可切换）
│   │   ├── ExplorePanel.vue          POI 探索侧边面板
│   │   └── ExplorePoiMiniMap.vue     探索卡内嵌的小地图（懒加载）
│   ├── store/
│   │   └── useItineraryStore.ts      Pinia 单例 store：状态、动作、持久化、撤销栈
│   ├── utils/
│   │   ├── amapLoader.ts             高德 JS API 单例加载器（含 fallback）
│   │   └── storage.ts                localStorage 包装
│   ├── App.vue                       主页面：输入面板 + 时间线 + 探索面板 + 各种 dialog
│   ├── main.ts                       入口：注册 Element Plus、Pinia、所有图标
│   ├── style.css                     全局样式 + Element Plus 主题覆盖（设计 token）
│   └── env.d.ts                      Vite 环境变量类型声明
├── .env.example                      环境变量模板
├── index.html                        HTML 模板（含 SEO meta）
├── package.json
├── tsconfig.*.json                   TypeScript 配置（app / node 分离）
└── vite.config.ts
```

---

## 使用指南

### 基本流程

1. **首次进入**：左侧描述需求 → `⌘↵` 生成
2. **生成完成**：右侧出现时间线，可悬停任意节点点"调"按钮微调
3. **批量调整**：toolbar 切到"批量选择"，勾选多个节点一并修改
4. **整体重排**：toolbar 的"重排整体"，让 AI 重做整份行程
5. **撤销**：`⌘Z` 回到上一步，`⌘⇧Z` 重做
6. **探索更多**：toolbar 的"探索景点"打开侧栏，浏览或搜索 POI 后插入 / 替换
7. **保存**：toolbar 的"保存为长图"导出 PNG

### 输入提示

prompt 写得越具体，模型给的方案越贴合。建议包含：

- 城市 / 区域：成都、京都、新疆环线
- 天数：周末 2 天、5 天 4 晚
- 主题：美食、亲子、City Walk、避开人挤人
- 预算：人均 ¥1500、预算友好型
- 出发城市与抵达方式（让 AI 给你 transit 节点）

例：`"成都 3 天，含一天大熊猫和川剧，住春熙路附近，预算人均 ¥1200，避开网红打卡店"`

### 重置 / 清空

toolbar 旁的"清空"按钮会一次性清掉：当前行程、输入框、全部历史记录、撤销栈、交通选择。生成之前按钮自动 disable。

---

## 快捷键

| 快捷键 | 行为 |
| --- | --- |
| `⌘↵` / `Ctrl+Enter` | 提交输入框 → 生成行程；正在生成时 → 取消 |
| `⌘Z` / `Ctrl+Z` | 撤销上一次修改 |
| `⌘⇧Z` / `Ctrl+Shift+Z` | 重做 |
| `Esc` | 关闭当前 dialog（Element Plus 内置） |

---

## LLM 提示词与模型选择

`src/api/llmService.ts` 中维护了三套提示词：

1. **生成提示词**：要求模型先联网搜索再输出，覆盖地址精度、节点数量、时长合理性、预算口径等约束
2. **修改提示词（按 scope）**：单节点 / 多节点 / 整日 / 整体，每种 scope 单独提示，包含联动调整规则
3. **探索推荐提示词**：让 LLM 给出 8 条带停留时长 + tips 的精选 POI

### 推荐模型

| 模型 | 特点 |
| --- | --- |
| **智谱 `glm-5.1`** ⭐ | 内置联网搜索 + 深度思考，地址 / 票价 / 时长最准；单次生成约 ¥0.05~0.20 |
| 智谱 `glm-4-flash` | 免费但无联网，速度快、地址偶尔虚构；适合演示 |
| 智谱 `glm-4-plus` | 收费，质量介于上两者 |
| DeepSeek `deepseek-chat` | 综合质量好，性价比高 |
| Kimi `moonshot-v1-8k` | 中文好，无内置联网工具时建议 `VITE_LLM_DISABLE_WEB_SEARCH=1` |
| OpenAI `gpt-4o` 等 | 海外景点效果好，国内地址匹配度略差 |

### 数据自纠正

LLM 偶尔会把交通枢纽（"平潭站""虹桥站"）误标成 `hotel` 或 `attraction`。Store 在数据进入 UI 前会自动跑一道 `correctActivityTypes`，命中"XX 站 / 机场 / 码头"等关键词的节点统一改回 `transit`。旧的 localStorage 数据加载时也会被纠正。

---

## 高德地图集成

启用高德 Key 后激活的功能：

- **每日地图**：每个 day 卡片下方独立 AMap 实例，按节点顺序绘制 marker + 折线
- **节点定位**：从地址 → 经纬度的批量 geocoding，带 4~5 个候选回退策略
- **路线规划**：步行 / 骑行 / 公交 / 驾车 + 打车（基于驾车数据 + 距离折算费率）
- **POI 检索**：探索面板里"高德全量"分类，以及关键词直搜
- **Mini Map**：探索 POI 卡片缩略图

### 失败缓存与降级

- 加载失败时缓存 30 秒，避免反复重试卡死页面
- 单节点 geocoding 失败会标红显示，可点击"重试失败的"按钮单独重跑
- 没配 Key 时主功能完全可用，地图区域显示引导卡片"去申请 Key"

---

## 数据持久化

所有数据写入 localStorage，刷新不丢。键名一览：

| 键 | 含义 |
| --- | --- |
| `itinerary` | 当前行程 |
| `userPrompt` | 输入框内容 |
| `history` | 最多 10 条历史快照 |
| `hasGenerated` | 是否生成过（用于空态判断） |
| `chosenModes` | 每个路段用户选定的交通方式 |
| `undoStack` / `redoStack` | 撤销 / 重做栈（深度 20） |

> 高德 geocoding 结果走内存级缓存，刷新即清空（避免缓存的坐标过期）。

---

## 构建与部署

```bash
npm run build
```

产物在 `dist/`，纯静态文件，可直接丢到任何 CDN / 对象存储 / Nginx：

- Vercel / Netlify：连仓库 → 自动部署
- 阿里云 OSS / 腾讯云 COS：把 `dist/` 上传，开启静态网站托管
- Nginx：把 `dist/` 拷到 root，路径配置 `try_files $uri $uri/ /index.html`

部署前注意：

1. 在生产域名下重新申请高德 Key 或在控制台把生产域名加入白名单
2. 把 `VITE_LLM_API_KEY` 通过部署平台的环境变量注入，不要硬编码到 .env 提交
3. 生产环境强烈建议把 LLM 调用挪到自建代理，避免 Key 暴露在前端

---

## 已知限制

- **LLM 偶尔虚构地址**：若使用免费 / 无联网模型，地址精度无保证。建议优先选 `glm-5.1` 或 DeepSeek
- **高德 jscode 暴露**：当前为前端直连方案，仅适合演示；上生产请走代理
- **跨城路线**：当某段过渡距离 ≥30km 时，会引导用户切到"打车 / 驾车"方式，但实际仍走城内驾车 API（不接铁路 / 航班 API）
- **Bundle 体积**：build 后单 JS chunk 约 1.4MB（gzip 后 450KB），主要来自 element-plus + html2canvas + 高德 SDK，按需后续可加 dynamic import 拆分
