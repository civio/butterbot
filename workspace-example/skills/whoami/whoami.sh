#!/bin/sh
# Plain sh, not bash: the executors run every command with `sh -c`, and a bare
# container (the README's alpine example) has nothing else installed.
printf '{"user":"%s","userId":"%s","channel":"%s","channelId":"%s","cwd":"%s"}\n' \
	"${BUTTERBOT_USER_NAME:-unknown}" "${BUTTERBOT_USER_ID:-unknown}" \
	"${BUTTERBOT_CHANNEL_NAME:-unknown}" "${BUTTERBOT_CHANNEL_ID:-unknown}" "$(pwd)"
