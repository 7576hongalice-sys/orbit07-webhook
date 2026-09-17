# Premarket trigger

The 07:30 ChatGPT premarket navigation is delivered by the ChatGPT automation. This repository provides a read-only official-data gate at `/cron/premarket`.

To reduce the risk of a missed GitHub scheduled event, `.github/workflows/cron_morning.yml` calls the same read-only gate at 07:20, 07:30, and 07:40 Asia/Taipei on Taiwan weekdays. The retries do not generate analysis, do not push Telegram messages, and do not modify the official post-market data repository.

The gate passes only when the latest completed prior trading day in `7576hongalice-sys/chencai-postmarket-data` is official-only and complete 7/7, with the matching compact history file also complete 7/7.
