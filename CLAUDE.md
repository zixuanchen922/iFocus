# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project overview

iFocus is a mobile-first PWA demo for a Physical AI-powered focus companion. A character orb reacts to real-time focus-state updates pushed from a detection backend (K3) via SSE. The experience is designed for landscape orientation on phones, with a developer panel for manual state testing.

## Commands

```bash
npm run dev           # Vite dev server on http://localhost:4173 (LAN accessible)
npm run build         # TypeScript check + Vite production build into dist/
npm run demo          # Production Node.js server on http://localhost:4173
npm run demo:video    # Production server with HTTPS + camera MJPEG enabled
npm run https:setup   # Generate local CA + certs for HTTPS camera streaming
```

`npm run build` must complete before `npm run demo` or `npm run demo:video` — the server serves static files from `dist/`.

## Architecture

### Frontend: React 18 + TypeScript + Vite

Single-page app with no router — all screens are conditionally rendered inside `App.tsx` based on the current `FocusState`. Entry point: [`src/main.tsx`](src/main.tsx).

**State machine** (defined in [`src/types.ts`](src/types.ts)): `idle → starting → focused → (distracted → recovered → focused) … → ending → finished`. Intermediate states like `suspected`, `intervening`, `offline`, and `error` exist but are mainly triggered manually from the developer panel.

**Key components (all in `src/`):**

- [`App.tsx`](src/App.tsx) — The entire app: state machine, SSE client, animation orchestration, developer panel. Contains 6 SVG animation models rendered as inline components (`PrimaryReminderModel`, `SecondaryReminderModel`, `TertiaryReminderModel`, `AbandonReminderModel`, `CompletionReminderModel`, `PrimaryRecoveryModel`) plus the `Mascot` component with its idle hop physics. Each reminder model reads `startPose` from the live DOM via `readCurrentOrbPose()` before animating to a fixed close-up endpoint.
- [`components/FocusSetupScreen.tsx`](src/components/FocusSetupScreen.tsx) — Task name input + duration slider (5–120 min, 5-min steps). Draggable ruler with digit rollover animations.
- [`components/ProfileScreen.tsx`](src/components/ProfileScreen.tsx) — Focus history (from localStorage) + cosmetic store (static catalog, no purchase flow).
- [`components/CameraPublisher.tsx`](src/components/CameraPublisher.tsx) — Optional phone camera → JPEG frames → HTTPS POST to server → MJPEG relay. Toggled via `?camera=1` query param or `IFOCUS_CAMERA_START_EVENT`.
- [`use-screen-wake-lock.ts`](src/use-screen-wake-lock.ts) — `navigator.wakeLock` hook, re-acquires on visibility change.
- [`camera-events.ts`](src/camera-events.ts) — Custom DOM event to trigger camera start from focus begin.

**CSS organization:** [`styles.css`](src/styles.css) (orb, clock, developer panel, animations), [`focus-setup.css`](src/focus-setup.css) (setup screen, portrait → landscape rotation), [`profile.css`](src/profile.css) (profile/store screens), [`camera-publisher.css`](src/camera-publisher.css) (camera status bar).

### Backend: `server.mjs`

Single-file Node.js server (no Express — raw `http`/`https` modules):

| Endpoint | Method | Purpose |
|---|---|---|
| `/api/display` | POST | Receive focus-state update from K3 backend (`display: "000"`–`"003"`, plus `"111"` for recovery) |
| `/api/display/events` | GET | SSE stream broadcasting display updates to all connected browsers |
| `/api/health` | GET | JSON stats: messages received, last display code, connected clients |
| `/api/video/frame` | POST | HTTPS-only JPEG upload from phone camera (validated as JPEG) |
| `/video_feed` | GET | MJPEG stream of latest camera frame (HTTPS-only) |
| `/api/video/status` | GET | Camera feature status |
| `/api/set_focus`, `/api/stop_temporary_focus`, `/api/continue_focus` | POST | Proxied to `FOCUS_BACKEND_URL` (PC-side Python detection service) |

Fallback static file serving from `dist/` for all other GET requests (SPA pattern — unknown paths serve `index.html`).

### Coordinate system and animation model

All animations use a **logical canvas of 1000×460** (landscape) or **460×1000** (portrait). The orb's position is always defined by full-circle center coordinates, never by eye positions. Device pixels are converted to logical coordinates via `canvasScale = min(actualWidth/1000, actualHeight/460)` with centered letterboxing.

Animation parameters are documented in [`PROJECT_SETTINGS.md`](PROJECT_SETTINGS.md). When modifying any animation, keep these constraints:
- Reminder animations read `startPose` from live DOM — they never assume a fixed starting position.
- Progress is expressed as relative ratios (0→1), not absolute pixel values.
- Eye spacing is an internal model attribute; orb center + scale are the authoritative position parameters.
- Recovery (display `111`) reuses the inverse of the primary motion keyframes without rebound or blinking.

### PWA

Manifest at [`public/manifest.webmanifest`](public/manifest.webmanifest), service worker at [`public/sw.js`](public/sw.js) (cache-first with network fallback, cache name `ifocus-shell-v6`). Service worker registers only in production builds.

### HTTPS / camera

[`scripts/setup-https.ps1`](scripts/setup-https.ps1) creates a local CA via Windows certificate store, generates a PFX cert for the LAN IP, and exports `certs/ifocus-rootCA.cer` for phone installation. All cert files are gitignored.

## Display protocol

K3 backend sends `POST /api/display` with JSON:
```json
{ "display": "001", "focus_state": "distracted", "duration": 4.2, "text": "..." }
```

Display codes:
- `"000"` — normal (ignored during distraction/recovery to prevent accidental dismissal)
- `"001"` — first-level peek/reminder (orb moves to close-up, blinks twice)
- `"002"` — second-level alert (orb close-up with angular alert eyes)
- `"003"` — third-level danger warning (orb close-up with red danger eyes)
- `"111"` — recovery (orb animates back to focused position)

The server accepts both string `"001"` and integer `1` for `display`. Duration defaults to 4.2s if omitted.
