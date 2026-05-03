#!/bin/bash
# Get local IP address for WebMQ server connection
IP=$(ifconfig | grep "inet " | grep -v 127.0.0.1 | awk '{print $2}' | head -1)
if [ -z "$IP" ]; then
  echo "export const SERVER_IP = 'localhost';" > config.ts
else
  echo "export const SERVER_IP = '$IP';" > config.ts
fi
echo "Server IP configured: $(cat config.ts)"
