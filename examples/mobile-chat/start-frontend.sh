#!/bin/sh
if command -v ip > /dev/null 2>&1; then
  IP=$(ip route get 1 | head -1 | awk '{print $7}')
else
  IP=$(ifconfig | grep 'inet ' | grep -v 127.0.0.1 | awk '{print $2}' | head -1)
fi
export EXPO_PUBLIC_WS_URL="ws://$IP:8080"
exec expo start
