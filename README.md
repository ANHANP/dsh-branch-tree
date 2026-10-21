# dsh-branch-tree

> 把 DeepSeek Harness 的会话分支历史变成一棵可以左右看、可以跳回去、可以继续追问的树。
>
> A session branch tree for DeepSeek Harness: rounds as cards, forks grown from the round they forked off, with a persistent right-side drawer, subagent forests and a minimap.

DSH 的非官方社区插件。当前为早期版本（0.1.x），在 DSH Desktop Beta（app 2.0.17-beta.2 / runtime 0.2.1-alpha.2，macOS）上测试。

## 它长什么样

屏幕右侧边缘有一个 `⑂` 把手，点开是一个独立的**持久抽屉**——切换会话、切换分支时抽屉不会消失，视角、缩放、展开状态都保留：

- **每个框 = 一轮对话**：最后一条用户消息 + 该轮最终助手回复；工具调用不占地方。
- **分支从它分叉的那一轮长出来**：fork 子会话的继承前缀被映射回父会话的那一轮，而不是接在兄弟分支的末端。
- **点击任意轮次卡**（包括卡内的「你 / AI」两行）→ 主对话切到该会话，并**按该轮用户消息的事件 seq 精确定位**，跨分支不会串到同号轮次；到位后描边高亮。
- **从任意已完成轮次开新分支**：悬停卡片，左侧出现小 `+`，弹出「新的追问」输入卡（快捷词点一下就直接发送，`+` 可自定义快捷词）。发送后自动 fork、发送这条追问、切到新分支。
- **子代理森林**：按创建时间落到对应轮次；卡片底部「代理 ×N」展开后从右缘长出去，受影响的对话节点整体右移让位。
- **缩略图**：右上角显示整棵树的剪影和当前视野框，点击/拖动即可导航。
- **自由平移**：没有滚动边界，拖动和双指滚动可以把树推到任何位置；缩放围绕指针。
- **跨会话保持**：抽屉只挂载一次，切会话只更新数据；相机存 `localStorage`。
- **点外部收起**：点主对话、顶栏或空白处收起；点左侧工作区/会话栏（以及它的下拉菜单）不会收起。Esc 同样收起。
- 深/浅色跟随 DSH。

## 安装

当前通过 **GitHub Release 的预构建 tarball** 分发（npm 包稍后；发布后这里会补上 npm 命令）：

```sh
dsh plugin --profile web add https://github.com/ANHANP/dsh-branch-tree/releases/latest/download/dsh-branch-tree.tgz
```

命令会自动把依赖和 `dsh.profile.bundles` 一起写好（已实测），装完重启 DSH。

- **DSH Desktop**：桌面端 profile 由应用自己管理，等本插件被 dsh-market 收录后可直接在插件市场一键安装；也可以把上面的 tarball 地址交给市场/插件管理器的安装入口。
- **本地开发**：`dsh plugin --profile <profile> add /path/to/dsh-branch-tree`，装完若 `dsh.profile.bundles` 未自动追加，手工加入 `"dsh-branch-tree"`。

## 使用

| 操作 | 效果 |
| --- | --- |
| 点右缘 `⑂` | 展开/收起抽屉 |
| 点轮次卡 / 卡内文本 | 跳到该轮 |
| 悬停卡 → 左侧 `+` | 开新分支输入卡；快捷词直接发送，`⌘/Ctrl+Enter` 发送，Esc 取消 |
| 双击分支名药丸 | 重命名分支（本地保存，之后自动名不再覆盖） |
| 点缩略图 / 拖动 | 跳转视野 |
| 拖动画布 / 双指滚动 | 平移；捏合（或 ⌘+滚轮）缩放 |
| `→` 提手 | 折叠按钮：展开时只显示小三角，收起时显示下方对话数 |
| 工具栏 `⇆` | 开关「轮次导航条镜像到左侧」（默认开） |

## 数据与隐私

宿主半只暴露两个只读路由（Host 头围栏，仅回环）：

- `GET /branch-tree/api/tree?sessionId=<id>` — 分支家族树、每轮投影、子代理森林。
- `GET /branch-tree/ui/*` — 抽屉的 iframe UI（每次请求读盘，所以改 UI 不需要重启）。

数据来自本机 DSH 的会话库（`sessionQuery`，能读到未打开的冷会话；缺失时退化为 live store）和 `subagents` 服务。轮次标题由 DSH 同一条模型路由（通常 `deepseek-flash`）生成并缓存到 `~/.dsh-beta/branch-tree/round-titles.json`；模型不可用时用本地截断占位。插件不上传数据，不发网络请求（除标题走 DSH 自己的模型路由）。

## 兼容性与已知限制

这是一个早期版本，依赖 DSH 的一些内部结构，DSH 升级后可能需要跟着修：

- 会话跳转依赖 chat 节点的 `anchorSeq` / `data-chat-anchor-key`、`loadThrough(seq)`。
- 轮次导航条镜像（对话列左侧的竖排小横杠）是**样式覆盖**，依赖 DSH 打包后的哈希类名；DSH 升级可能失效（UI 其余部分不受影响）。
- 「推挤式展开」是**实验性**的：尝试让主对话为抽屉让位，部分布局版本上可能看不到效果。
- 子代理卡片只读，按节点聚合；从某一轮开新分支要求该轮已完成；侧边对话（side chat）不在树里。
- 只在 macOS 的 DSH Desktop Beta 上验证过；窄窗口、其他客户端未验证。

## 开发

```sh
node --check index.js && node --check client.js && node --check ui/app.js
node --test test/extract.test.mjs test/titles.test.mjs
```

调试（可选，默认关闭）：

- 宿主：`DSH_BRANCH_TREE_DEBUG=1` 才会注册诊断路由 `/branch-tree/api/debug`，写入 `~/.dsh-beta/branch-tree/debug.jsonl`。
- 客户端：`localStorage['dsh-branch-tree:debug']='1'` 才会上报推挤诊断。

文件结构：`index.js` 宿主半（路由 + 数据投影 + 标题生成）、`client.js` 浏览器半（抽屉 + 会话同步 + 跳转）、`ui/` iframe UI、`lib/extract.js` 纯函数、`test/` 单元测试。

## 致谢

- 「新的追问」输入卡的交互与视觉灵感来自 [dsh-synapse](https://github.com/liangmianya/dsh-synapse)（会话地图插件，MIT）里的追问卡片。本项目独立实现，未复制其源码。
- 会话切换、按事件 seq 定位与「抽屉浮层 + 不打断主对话」的实现思路同样参考了 dsh-synapse。
- 感谢 DeepSeek Harness 与社区插件生态。

本项目是**非官方**社区插件，与 DeepSeek / DeepSeek Harness 官方无隶属或背书关系。

## License

MIT
