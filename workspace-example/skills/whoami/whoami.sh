#!/bin/sh
# Plain sh, not bash: the executors run every command with `sh -c`, and a bare
# container (the README's alpine example) has nothing else installed.
printf '{"user":"%s","userId":"%s","channel":"%s","channelId":"%s","cwd":"%s"}\n' \
	"${DAD_USER_NAME:-unknown}" "${DAD_USER_ID:-unknown}" \
	"${DAD_CHANNEL_NAME:-unknown}" "${DAD_CHANNEL_ID:-unknown}" "$(pwd)"
