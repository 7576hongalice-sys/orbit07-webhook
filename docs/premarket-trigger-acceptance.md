Acceptance criteria on the next Taiwan trading day:
1. At least one scheduled run is created around 07:20, 07:30, or 07:40 Asia/Taipei.
2. The run calls `/cron/premarket` with the existing `CRON_KEY` header.
3. The endpoint returns success only when the previous trading day's official gate is 7/7 complete.
4. No Telegram message is sent by this gate.
5. The ChatGPT 07:30 automation remains the navigation delivery layer.
