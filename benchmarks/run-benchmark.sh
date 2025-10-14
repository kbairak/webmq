#!/bin/bash

# Colors for output
GREEN='\033[0;32m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

echo -e "${BLUE}🚀 Starting WebMQ Benchmark Environment${NC}"

# Start docker-compose services
echo -e "\n${GREEN}📦 Starting Docker services (RabbitMQ, Prometheus, Grafana)...${NC}"
docker-compose up -d

# Wait for services to be ready
echo -e "${GREEN}⏳ Waiting for services to be ready...${NC}"
sleep 5

# Check if Grafana is up
until curl -s http://localhost:3000 > /dev/null; do
  echo "Waiting for Grafana..."
  sleep 1
done

echo -e "${GREEN}✅ All services ready!${NC}"

# Get the dashboard UID (we'll use a fixed one in the JSON)
DASHBOARD_URL="http://localhost:3000/d/webmq-benchmark/webmq-benchmark-dashboard?orgId=1&refresh=1s&from=now-5m&to=now"

echo -e "\n${GREEN}📊 Opening Grafana dashboard...${NC}"
# Open Grafana dashboard (works on macOS, Linux, WSL)
if command -v open &> /dev/null; then
  open "$DASHBOARD_URL"
elif command -v xdg-open &> /dev/null; then
  xdg-open "$DASHBOARD_URL"
else
  echo "Please open: $DASHBOARD_URL"
fi

# Run the benchmark with passed arguments
echo -e "\n${BLUE}🏃 Starting benchmark...${NC}\n"
node benchmark.js "$@"

# Cleanup function
cleanup() {
  echo -e "\n${GREEN}🧹 Stopping Docker services...${NC}"
  docker-compose down
  echo -e "${GREEN}✅ Cleanup complete${NC}"
}

# Trap EXIT to ensure cleanup
trap cleanup EXIT
