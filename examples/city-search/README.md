# City Explorer - WebMQ Multi-Source Search Demo

A real-time city search application that demonstrates WebMQ's ability to coordinate multiple backend workers, each fetching data from different sources.

## Architecture

When you search for a city, the frontend publishes a single message. Three independent workers listen for search requests and each fetches data from different APIs:

1. **Weather Worker** - Fetches current weather from Open-Meteo API
2. **Wikipedia Worker** - Fetches city information from Wikipedia
3. **Images Worker** - Fetches photos from Wikimedia Commons

Each worker publishes its results independently, and the frontend displays them as they arrive in real-time!

## Features

- **Real-time results** - Watch results appear one by one as workers respond
- **Multiple data sources** - Weather, Wikipedia, and images all in one search
- **Type-safe rendering** - Generic result types (keyvalue, markdown, image) work for any data source
- **Beautiful UI** - Gradient background, smooth animations, responsive cards
- **No authentication required** - All APIs are free and open

## Setup

```bash
# Install dependencies
npm install

# Start everything (RabbitMQ + backend + workers + frontend)
npm start
```

This will:
1. Start RabbitMQ via Docker Compose
2. Start the WebMQ server on ws://localhost:8080
3. Start all three workers
4. Start Vite dev server on http://localhost:5173

## Try It Out

Search for any city in the world! The workers will automatically find and fetch data for it.

Examples: Paris, London, New York, Tokyo, Sydney, Berlin, Rome, Barcelona, Amsterdam, Dubai, Singapore, San Francisco, Los Angeles, Chicago, Toronto, Moscow, Istanbul, Cairo, Mumbai, Bangkok

## How It Works

```
User searches "Paris"
  ↓
Frontend publishes to: search.request.{uuid}
  ↓
Workers (all listening to search.request.*):
  - Weather worker fetches from Open-Meteo
  - Wikipedia worker fetches from Wikipedia API
  - Images worker fetches from Wikimedia Commons
  ↓
Each worker publishes to: search.results.{uuid}
  ↓
Frontend receives results and displays them as cards!
```

## Adding More Workers

Want to add a new data source? Just create a new worker file in `backend/workers/`:

```javascript
import amqplib from 'amqplib';

const connection = await amqplib.connect('amqp://localhost');
const channel = await connection.createChannel();

await channel.assertExchange('city_search', 'topic', { durable: true });
const { queue } = await channel.assertQueue('', { exclusive: true });
await channel.bindQueue(queue, 'city_search', 'search.request.*');

channel.consume(queue, async (msg) => {
  const { searchId, query } = JSON.parse(msg.content.toString());

  // Fetch your data
  const data = await yourAPI.search(query);

  // Publish results
  channel.publish(
    'city_search',
    `search.results.${searchId}`,
    Buffer.from(JSON.stringify({
      searchId,
      source: 'your-source',
      results: [/* your results */]
    }))
  );

  channel.ack(msg);
});
```

Import it in `backend/workers/index.js` and you're done!

## Result Types

The frontend supports these generic result types:

- **keyvalue** - Key-value pairs (used for weather data)
- **markdown** - Markdown text (used for Wikipedia summaries)
- **image** - Images with captions (used for photos)
- **list** - Bulleted lists
- **text** - Plain text

Any worker can use any type!
