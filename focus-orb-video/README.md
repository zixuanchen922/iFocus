# 专注球 Remotion 演示视频

手机横屏（1920×1080、30fps）黑底演示，重点用白色外圈表达球体与用户之间的远近关系。

## Composition

- `FocusInteraction`：11 秒。点击开始、大尺寸倒计时、躲在时钟后眨眼、连续跳出并 Q 弹落地、从左上角进入近景观察用户。
- `DistractionAlert`：4 秒。球体快速贴近，外圈扩大并移出视野，眼睛在途中渐变为黄色提醒状态。
- `FocusOrbDemo`：15 秒。按顺序组合上述两个片段。

## 输出文件

- `output/focus-interaction.mp4`
- `output/distraction-alert.mp4`
- `output/focus-orb-demo.mp4`

## 本地预览和重新渲染

```powershell
npm install
npm run dev
npm run render:focus
npm run render:alert
npm run render:demo
```

素材位于 `public/`。三个眼睛状态均保留为参考，其中黄色状态用于分心提醒动画；`orb-reference.png` 是由原始 HEIC 转换得到的实物形象参考。
