# iFocus 横屏 PWA Demo

iFocus 的 P0 手机端状态屏。主画面只使用中央形象、背景色和动作反馈；右侧开发者面板用于手动触发状态，不再包含自动 Mock 流程。

打开网页后会先进入任务定义页面：输入任务名称，通过滑块选择 5–120 分钟的专注时长，然后点击“开始”。未填写任务名称时开始按钮不可用。专注时间到期后页面会自动进入结束状态。

## 本地运行

```powershell
npm install
npm run dev
```

访问 `http://localhost:4173`。生产演示使用：

```powershell
npm run build
npm run demo
```

生产演示地址为 `http://localhost:4173`。

## 横屏与手机适配

- PWA Manifest 将首选方向设置为 `landscape`。
- 点击 START 时会立即请求浏览器全屏并隐藏导航栏，然后再尝试锁定横屏。
- Manifest 使用 `fullscreen` 优先、`standalone` 回退；页面背景和浏览器主题色会跟随当前状态，避免安全区域出现白边。
- 页面使用视口尺寸和安全区域变量适配不同手机比例、刘海和圆角区域。
- 普通浏览器不一定允许网页强制旋转；竖屏访问时页面仍可操作，并显示横屏提示。
- iPhone Safari 如果拒绝网页全屏，需要先通过“分享 → 添加到主屏幕”，再从桌面图标启动 PWA。

## 开发者状态测试

右侧面板可以手动触发待机、开始、专注、疑似分心、确认分心、Agent 提醒、恢复、结束、离线和错误状态。

点击“开始专注”后，中央形象先上下晃动，绿色圆形随后扩散到整个主画面。其余状态暂时使用背景颜色切换和轻量动作表示。

## 展示更新接口

接口保持为 `POST /api/display`。`display` 是前端选择动作的主字段：`"000"` 表示正常，`"001"`、`"002"`、`"003"` 分别保留为不专注提醒阶段一、二、三。阶段二、三的独立动画尚未定义，目前都会进入不专注状态并保留原始阶段码。

JSON 数字不能保留前导零，因此推荐传字符串 `"000"`～`"003"`；服务端也兼容整数 `0`～`3`。

```json
{
  "text": "用户现在不专注，正在看微信，需要提醒",
  "display": "001",
  "focus_state": "distracted",
  "duration": 4.2
}
```

其中只有 `display` 是必须字段。`text`、`focus_state` 和 `duration` 均为可选字段；`focus_state` 作为业务描述保留，但不再覆盖 `display` 对应的前端动作。

```powershell
$body = @{
  text = "用户现在不专注，正在看微信，需要提醒"
  display = "001"
  focus_state = "distracted"
  duration = 4.2
} | ConvertTo-Json

Invoke-RestMethod -Method Post `
  -Uri http://localhost:4173/api/display `
  -ContentType "application/json; charset=utf-8" `
  -Body ([Text.Encoding]::UTF8.GetBytes($body))
```

`text` 仍会被接口接收，但这一版不会在主画面显示文字。`duration` 到期后会自动回到绿色专注状态。

## 实时监测数据传输

服务端会记录接收总数和最近一条消息的元信息。查看一次：

```powershell
Invoke-RestMethod http://localhost:4173/api/health | ConvertTo-Json
```

持续刷新：

```powershell
while ($true) {
  Clear-Host
  Invoke-RestMethod http://localhost:4173/api/health | ConvertTo-Json
  Start-Sleep -Seconds 1
}
```

重点观察 `messages_received` 是否增长、`last_received_at` 是否更新、`last_display` 是否与 K3 发送值一致，以及 `display_clients` 是否大于 0。服务端终端也会逐条输出 `[display]` 日志，但不会打印 `text` 原文。

前端右侧开发者面板还提供临时“接收日志”，会显示 SSE 连接状态、每条 JSON 的原始字段和最终状态映射。日志最多保留最近 30 条，可随时清空。

## 声音测试

页面使用 Web Audio 生成测试提示音，不依赖外部音频文件。浏览器通常要求用户先点击页面后才能播放声音，因此第一次进入时需要点击“开始专注”或右侧“点击启用声音”。完成这次解锁后，页面保持打开时，后续接口状态通常可以直接触发声音。

如果手机锁屏、浏览器进入后台或系统暂停网页，声音和实时连接可能被暂停；比赛演示时建议保持 PWA 在前台且关闭自动锁屏。
