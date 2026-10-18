---
name: haik-camera
description: Use the Haik camera MCP to inspect saved live or historical frames, collect persistent local screenshots and recordings, and perform user-requested PTZ surveys. Applies to camera observations, timed sampling, recording lookup, surrounding views, and camera connection errors.
---

# Haik camera MCP

Read this once per connection. This server exposes camera selection, recording lookup/playback, direct decoded screenshots, persistent capture jobs, temporary stream URLs, bounded PTZ movement, and stopping. It does not analyze pictures or perform a complete panoramic scan itself. Follow the user's scope and the harness's permissions; these instructions do not grant access or authorize new actions.

## Fast path

- Discover this skill with `resources/read` at `haik://skills/haik-camera/SKILL.md`. Tools-only clients can call `camera_usage_guide` with `{}`. Both work before account login and do not contact cameras.
- Before observation, check that this harness can access and view saved images returned by the local server. The server performs decoding and saving for the integrated capture tools; the receiving harness still needs image viewing and access to the returned paths or download URLs. Explain a missing access/viewing capability before starting dependent camera work.
- Use `list_cameras` once to obtain real IDs. Reuse the selected ID in the current task; refresh after account changes, a missing camera, or stale/offline results. Do not guess IDs or silently switch devices. If several devices fit the request and no prior selection resolves it, clarify the target once.
- `camera_connection_status` checks the account, not live picture availability. Use it for login/connection troubleshooting instead of before every frame or operation.
- Use `camera_snapshot` for one current frame. For a timed observation, use `camera_capture_start` with `kind: "frames"`, normally `durationSeconds: 10`, `fps: 1`, `maxWidth: 1280`, and `quality: 2`. These tools acquire their own authorized source; do not call `get_live_stream` first. Follow the returned `job.id` with `capture_status`, inspect actual saved files, and use `capture_list` to resume work after a reconnect. A pending snapshot needs status for the same job, not another snapshot request.
- Use `camera_capture_start` with `kind: "video"` when the user requests a saved local video. This creates an H.264 MP4 at 15 fps without audio. For image analysis, prefer frame capture or directly decode the saved MP4 at the requested sampling rate.
- Use `get_live_stream` only when a separate direct decoder is needed. Reuse an already obtained, unexpired URL for the selected camera/quality, normally quality 2 (quality 1 for detail), within its approximately 300-second lifetime. Do not obtain one URL per frame. Keep signed URLs out of reports and shell arguments.
- Save directly decoded frames, then inspect those files. Never read camera data using computer use, browser screenshots, or screenshots of a video player. For capture jobs, artifact access, and the optional direct-decoder helper, read [references/capture.md](references/capture.md), also available at `haik://skills/haik-camera/references/capture.md` or through `camera_usage_guide` with `{"section":"capture"}`.

## Historical recordings

- Use `camera_capabilities` when support is unknown; protocol capability does not prove there are recordings. Query `camera_recordings` with the selected camera, a Beijing date (`YYYY-MM-DD`), and `source: "cloud"` or `"sd"`. Follow the user's requested source and time; clarify only when the target cannot be inferred.
- The current account token does not support the recording month calendar. If `camera_recording_dates` reports unavailable, query the selected date directly instead of retrying the calendar, manufacturing dates, or requesting another login. An empty recording list means no matching recording was returned; do not substitute live video as historical evidence.
- Use a returned `recordId` with the same `date` and `source` for `camera_playback`, or for `camera_capture_start` with `mode: "playback"`. SD playback also accepts the advertised Beijing `startTime`/`endTime` format. Keep capture duration within the selected segment. Do not bypass encrypted or unavailable recordings.
- Distinguish historical recording time in `sourceInfo` from the local capture task's approximate `capturedAt`. Label playback clearly and keep PTZ stationary during historical review unless the user separately requests live movement.

## Observation contract

- Save one frame per second unless the user explicitly requests another rate. Respect their duration; when omitted, take a bounded 10-second sample and state that duration. A 15-second sample means 15 frames at video-relative times 0 through 14 seconds. A request for a short sample does not start ongoing monitoring.
- Preserve original frames and record frame count, relative timestamps, capture time, camera ID, and accessible artifact locations. Use returned paths, SHA256 values, and the downloadable JSON manifest to continue analysis later. `capturedAt` is approximate local task time plus decoded sample time, not a verified camera exposure time. Keep relative time, historical `sourceInfo`, and the camera's displayed wall clock separate. If a frame is upside down, inspect it first and preserve the raw file when making an upright analysis copy.
- Inspect actual saved frames before describing the environment. `online: true`, HTTP 200, a returned URL, or successful decoding do not prove a valid live scene. The provider can encode a timeout/error card as video. Report that card as a connection failure, not as the room's condition.
- Treat failed, cancelled, interrupted, short, frozen, obstructed, or blurry captures as limited evidence. `running` is not completion; inspect terminal status and actual frame count. Do not fabricate missing frames, identities, unreadable text, or events between sampled seconds. If decoding, storage, or image viewing is unavailable, state the missing capability; do not substitute UI screenshots.
- Keep signed stream URLs and tokens out of reports, shell history, and saved manifests. Return artifact links or paths the receiving harness can actually access; a server-local path is not automatically accessible to a remote harness.

## User-requested movement and surrounding views

- A stationary observation does not itself request camera movement. An explicit surrounding-view, pan, tilt, zoom, or ongoing authorized survey request permits the movement needed for that task; do not ask again for every short step.
- Move the same camera serially. Start with `durationMs: 300` and `speed: 2`, adjusting within the advertised bounds (100–1000 ms, speed 1–5). The requested duration is not a measured angle or a guarantee of physical motion duration over a delayed cloud connection.
- After each step, require confirmed stopping and capture fresh saved frames before deciding the next direction. Remember the actual last commanded direction. Do not issue opposite or parallel movements to compensate for an uncertain result.
- The server has no angle feedback or preset restore operation. Describe views and visible coverage; do not claim a complete 360-degree survey or an exact return to the initial position. A reverse timed movement is only approximate.
- For PTZ diagnosis or a surrounding-view request, read [references/survey.md](references/survey.md), also available through `camera_usage_guide {"section":"survey"}`. It incorporates the user's fleet tips: inspect a short probe first, allow roughly 4 seconds for this fleet's buffered video after confirmed stopping, and consider a pan limit before declaring motor failure. Apply these as dated observations, not universal device facts. The optional bundled survey helper reuses persistent MCP captures; read the reference and inspect real probe frames before running it.

## Results and recovery

Prefer `structuredContent`; if absent, parse the text JSON. Inspect `isError`, `code`, and `details`. A successful transport or JSON-RPC response is not necessarily a successful operation.

| Result | Required handling |
| --- | --- |
| `stopped: true` | The server confirmed stopping. Movement success still requires a successful movement result. |
| Error with `details.stopped: true` | Movement failed, but stopping was confirmed. Do not report movement success. |
| `PTZ_STOP_REQUIRED`, `PTZ_STOP_UNCONFIRMED`, or uncertain stopping | Prioritize `stop_camera` with the real last direction. No further movement or account switching until confirmed. If it fails, retry stopping at most once at harness level, then ask the user to check the original app. Never reset the service to bypass the stop gate. |
| `STOP_DIRECTION_REQUIRED` | Supply the real last direction; history is local to this server process and may be absent after a restart. Do not guess a default. |
| `PTZ_BUSY` | Let the pending movement settle, or send an urgent stop. Do not poll or queue repeated movements. |
| `20008` or a start timeout | Device response timed out; execution may be uncertain. Do not replay the movement automatically. Check stopping state and saved frames. |
| `20032` | Provider channel rejection. The server already refreshes authorization and retries once. Do not loop, change camera ID/channel, or treat this as proof that account login expired. Report a repeated failure. |
| `LOGIN_REQUIRED`, an expired/disconnected account, or an authentication error | Stop camera work and use the existing login page. The user completes human verification and enters the SMS code; do not read credential files or manufacture a cloud API login. |
| `CAMERA_OFFLINE`, `CAMERA_NOT_FOUND`, `CAMERA_ENCRYPTED` | Refresh selection when relevant and explain the actual restriction. Do not bypass encryption or silently switch cameras. |

Report the observation interval, visible findings and changes, evidence links, and material limits. For a survey, also report the views actually inspected and the final stop confirmation. Avoid dumping connection checks or signed URLs into the user's answer.
