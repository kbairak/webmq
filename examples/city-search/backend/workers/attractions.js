import amqplib from 'amqplib';

const RABBITMQ_URL = 'amqp://localhost';
const EXCHANGE_NAME = 'city_search';

async function fetchAttractions(cityName) {
  // Use Overpass API to find attractions in the city
  const query = `
    [out:json][timeout:25];
    area[name="${cityName}"]->.searchArea;
    (
      node["tourism"~"attraction|museum|monument|viewpoint"](area.searchArea);
      way["tourism"~"attraction|museum|monument|viewpoint"](area.searchArea);
    );
    out center 15;
  `;

  const url = 'https://overpass-api.de/api/interpreter';
  const response = await fetch(url, {
    method: 'POST',
    body: query
  });

  const data = await response.json();

  if (!data.elements || data.elements.length === 0) {
    return [];
  }

  // Extract unique attraction names
  const attractions = data.elements
    .filter(el => el.tags && el.tags.name)
    .map(el => el.tags.name)
    .filter((name, index, self) => self.indexOf(name) === index) // Remove duplicates
    .slice(0, 10); // Limit to 10 attractions

  return attractions;
}

async function startWorker() {
  const connection = await amqplib.connect(RABBITMQ_URL);
  const channel = await connection.createChannel();

  await channel.assertExchange(EXCHANGE_NAME, 'topic', { durable: true });

  const { queue } = await channel.assertQueue('', { exclusive: true });
  await channel.bindQueue(queue, EXCHANGE_NAME, 'search.request.*');

  console.log('🏛️  Attractions worker started, listening for search requests...');

  channel.consume(queue, async (msg) => {
    if (!msg) return;

    try {
      const { searchId, query } = JSON.parse(msg.content.toString());
      console.log(`🏛️  Fetching attractions for ${query}...`);

      const attractions = await fetchAttractions(query);

      if (attractions.length > 0) {
        const result = {
          searchId,
          source: 'attractions',
          results: [
            {
              id: `attractions-${searchId}`,
              type: 'list',
              title: 'Top Attractions',
              data: attractions
            }
          ]
        };

        channel.publish(
          EXCHANGE_NAME,
          `search.results.${searchId}`,
          Buffer.from(JSON.stringify(result))
        );

        console.log(`✅ Attractions data sent for ${query} (${attractions.length} items)`);
      } else {
        console.log(`⚠️  No attractions found for ${query}`);
      }

      channel.ack(msg);
    } catch (error) {
      console.error('❌ Attractions worker error:', error);
      channel.nack(msg, false, false);
    }
  });
}

startWorker().catch(console.error);
