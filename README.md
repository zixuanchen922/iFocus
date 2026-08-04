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

接口保持为 `POST /api/display`。`display` 是前端选择动作的主字段：`"000"` 表示正常，`"001"`、`"002"`、`"003"` 分别表示不专注提醒阶段一、二、三。

JSON 数字不能保留前导零，因此推荐传字符串 `"000"`～`"003"`；服务端也兼容整数 `0`～`3`。

```json
{
  "text": "用户现在不专注，正在看微信，需要提醒",
  "display": "001",
  "focus_state": "distracted",
  "duration": 4.2
}
```

其中只有 `display` 是必须字段。`text`、`focus_state` 和 `duration` 均为可选字段；传入时必须分别是字符串、字符串和非负数字。

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

`001`、`002`、`003` 使用请求中的 `duration` 播放动画；未提供时默认使用 4.2 秒，并在动画完成后保持最终状态。

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

## 可选摄像头视频流

视频功能默认关闭，且与现有动画状态机相互独立。启用后，手机浏览器在当前动画页面内采集摄像头，将 JPEG 帧通过 HTTPS 上传到 Node 服务；远程客户端通过 MJPEG 接口查看实时画面。帧只保存在内存中，不写入磁盘。

首次使用，在 Windows 上通过系统证书 API 自动创建本地开发 CA，并为当前局域网 IP 生成证书，不需要安装第三方工具：

```powershell
npm run https:setup
```

如果自动识别的网卡不正确，可以手动指定 IP：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/setup-https.ps1 -IpAddress 192.168.252.77
```

脚本会在 `certs/` 下生成服务端 PFX、随机口令文件和可安装到手机的 `ifocus-rootCA.cer`。这些文件均被 Git 忽略。只将 `ifocus-rootCA.cer` 安装到手机；CA 私钥只保存在当前 Windows 用户的证书库中，不会导出到项目。

构建并启动双协议服务：

```powershell
npm run build
npm run demo:video
```

- 原有 HTTP 服务仍在 `http://<电脑IP>:4173`，K3 接口不受影响。
- HTTPS 服务位于 `https://<电脑IP>:4174`，与 HTTP 服务共享显示状态和连接。
- 手机打开 `https://<电脑IP>:4174/?camera=1`，点击“启用摄像头”并允许权限。
- `camera=1` 会在当前手机保存摄像头控制开关，因此安装到桌面后从 PWA 图标启动仍会显示；访问 `?camera=0` 可关闭该控制。
- 远程查看地址：`GET https://<电脑IP>:4174/video_feed`。
- 响应类型：`multipart/x-mixed-replace; boundary=boundary`，帧分隔符为 `--boundary`。
- 状态接口：`GET /api/video/status`。
- 内部帧上传接口：`POST /api/video/frame`，请求体为单张 JPEG；该接口仅接受 HTTPS。

摄像头权限不能由网页静默授予，首次启动必须由用户点击并在浏览器中确认。iPhone 还需要安装 `ifocus-rootCA.cer` 描述文件，并在“设置 → 通用 → 关于本机 → 证书信任设置”中启用完全信任，然后再访问 HTTPS 地址。
