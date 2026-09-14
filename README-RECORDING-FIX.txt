RECORDING FLOW FIX

Base: LelaConnect-recording-final-fixed.zip

Recording behavior:
1. User presses Record once.
2. Only the other participant sees Allow / Decline.
3. If allowed, the requester's button changes to Stop + timer.
4. Pressing Stop finalizes the recording and opens the preview.
5. Preview has Save to device and Delete.
6. Save uses the native save-location picker where supported; browsers without it use a normal download fallback.
7. Next pauses an active recording and does not finalize it. A new stranger gets a fresh one-time consent request.
8. Stop Camera finalizes the recording, then stops the camera, microphone, WebRTC connection, and chat.
9. Recording bytes are never sent to the server.
