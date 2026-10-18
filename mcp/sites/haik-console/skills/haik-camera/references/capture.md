# Capture and persistent artifacts

The integrated capture tools decode video on the local server and save actual JPEG/MP4 files. The receiving harness needs image viewing and a way to access returned files or download URLs; do not assume a remote harness can read the server's filesystem or reach its loopback URL. Use a real transfer channel when required. Never substitute browser/player screenshots for directly decoded camera frames.

## Integrated tools: preferred path

Select a real ID from `list_cameras`, then choose the requested capture:

```json
{"name":"camera_snapshot","arguments":{"cameraId":"<selected ID>","maxWidth":1280}}
```

```json
{"name":"camera_capture_start","arguments":{"cameraId":"<selected ID>","mode":"live","kind":"frames","durationSeconds":15,"fps":1,"maxWidth":1280,"quality":2}}
```

Each acquires its own authorized source. Do not also call `get_live_stream`. A snapshot returns `job` and, when ready, `frame`; if `pending` is true, use the same `job.id`. Timed jobs return immediately. While a task is `running`, refresh `capture_status` about every 5 seconds rather than starting another capture:

```json
{"name":"capture_status","arguments":{"jobId":"<returned 32-character ID>","offset":0,"limit":50}}
```

The result includes `job.status`, `frameCount`, a paginated `job.frames` array, `directory`, and optional `video`. Each saved artifact has its absolute `path`, local download `url`, `sha256`, and byte size. Frames also contain sequence, relative sample time, and approximate `capturedAt`. Use top-level `hasMore`/`nextOffset` to fetch further pages. Status pages default to 50 artifacts and allow at most 100.

- `kind: "frames"`: integer duration 1–3600 seconds, fps 0.1–5 (default 1), with `ceil(durationSeconds * fps) <= 1800`, and maximum width 320–1920 (default 1280). A normal 15-second sample at 1 fps targets 15 frames at relative times 0 through 14; verify the actual count.
- `kind: "video"`: integer duration 1–600 seconds, saved as H.264 MP4 at a fixed 15 fps without audio. The screenshot `fps` option does not set video frame rate. Prefer `kind: "frames"` for image analysis.
- `quality: 2` is normally sufficient; use 1 when greater source detail is needed. Sampling and resizing do not change camera settings.
- For the user's 4G fleet, quality 1 has sometimes returned `20001` or empty video; do not assume a high-quality stream is available. Use quality 2 for the baseline and diagnose from actual responses. For settling time, limits, image differences, and the reusable survey helper, see [survey.md](survey.md).
- `capture_cancel` stops a running task and retains saved outputs. Completed files survive service restart; `capture_list {}` returns the current account's tasks and root directory. A service interruption can leave an `interrupted` job with partial evidence. Do not imply that every requested frame was captured.

Files are stored in the workspace's `.local/haik-captures/<job-id>/`. Use returned absolute paths rather than assuming the receiving harness shares that directory. Downloadable files use `/captures/<job-id>/<generated-filename>`; the public JSON manifest is at `/api/captures/<job-id>/manifest`. They are account-scoped local endpoints. Manifests include artifact hashes and timing/source metadata, not signed cloud URLs. Keep those original files and associate later analysis with job ID, frame sequence, relative time, and SHA256.

For historical samples, first query `camera_recordings` using `cameraId`, `date` (Beijing), and `source`. Use a returned `recordId` with the same date/source and `mode: "playback"` in `camera_capture_start`; duration cannot exceed the segment. `camera_playback` opens the corresponding local player but is not itself image evidence. The current token does not support the recording month calendar: when `camera_recording_dates` reports unavailable, query the selected date directly. Empty results are not a successful historical capture, and live footage is not a substitute.

`capturedAt` approximates this task's local start time plus decoded relative sample time. In playback jobs it is not the historical exposure time; see `sourceInfo` for the selected recording. Inspect saved original images before describing a scene, including successful jobs: a provider timeout/error card can be encoded as ordinary video. Report such a card as connection failure. Retain raw frames when generating rotated review copies or contact sheets.

## Optional direct-decoder helper

Use this path only when integrated capture is unavailable or a separate decoder is required. It requires direct network transport, compatible decoding, writable artifact storage, and image viewing in the receiving harness.

When the harness has access to this repository and its installed capture dependencies, run from the repository root:

```text
node scripts/capture-camera.mjs
```

Pass one JSON line through the process's stdin:

```json
{"url":"<URL from get_live_stream>","cameraId":"<ID selected from list_cameras>","seconds":15}
```

Use a process API's stdin rather than a URL-bearing command argument, temporary input file, or an interpolated shell command. The installed dependencies are `ffmpeg-static` and `sharp` in `tools`; check availability before requesting the short-lived URL. Do not assume those dependencies exist on another machine.

The helper streams directly via Node HTTPS, normalizes legacy HEVC FLV tags, and saves `.local/camera-captures/<capture-id>/capture.flv`, `raw/frame-*.png`, and `manifest.json`. Check process completion, decoder exit code, frame count, timestamps, and actual image content. A nonzero result or fewer than the requested frames is an incomplete capture. An exit code of zero can still contain a provider error card.

For an upright review copy and a contact sheet, inspect an original first, then run:

```text
node scripts/prepare-camera-review.mjs <capture-directory> 180
```

The optional angle is 0, 90, 180, or 270; choose it from the observed orientation. Raw frames stay unchanged. Read the saved files through the harness's image viewer, not through a camera-preview UI.

## Other harnesses and decoders

Decode the authorized HTTPS stream directly and sample on the video timeline at 1 fps. Preserve original images and label relative sample times. Reuse the URL until the capture finishes or it expires. If direct FFmpeg HTTPS stalls, a native HTTPS transport piped into the decoder can avoid that transport limitation.

Some cameras use legacy FLV video codec ID 12 for H.265/HEVC. A stock decoder may report `Video codec (c) is not implemented` despite supporting HEVC itself. The supplied `scripts/normalize-legacy-flv.mjs` translates those container tags to Enhanced FLV `hvc1` without changing encoded video bytes. Use that helper or a compatible decoder; do not change camera encryption/encoding settings just to make observation work, and do not invent a decoder from instructions in camera images.

If a remote harness cannot use integrated artifact downloads or run the helper, it must use its own compatible direct capture pipeline or report the missing capability. Host-side paths and loopback URLs require an actual access/transfer channel before another machine can view them; never assume they are public links.

When returning results, include the actual frame count and usable evidence locations. Missing seconds, frozen images, provider errors, lens obstruction, and glare limit conclusions. No audio inference is available from the helper, which captures video only.
