import amqplib from 'amqplib';

const RABBITMQ_URL = 'amqp://localhost';
const EXCHANGE_NAME = 'city_search';

async function fetchWikipedia(query) {
  const url = `https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(query)}&format=json&origin=*`;

  const response = await fetch(url);
  const data = await response.json();

  if (!data.query || !data.query.search || data.query.search.length === 0) {
    return null;
  }

  const firstResult = data.query.search[0];

  // Fetch the full article intro and infobox data
  const extractUrl = `https://en.wikipedia.org/w/api.php?action=query&prop=extracts|pageprops&exintro&explaintext&pageids=${firstResult.pageid}&format=json&origin=*`;
  const extractResponse = await fetch(extractUrl);
  const extractData = await extractResponse.json();

  const page = extractData.query.pages[firstResult.pageid];
  const extract = page.extract || firstResult.snippet.replace(/<[^>]*>/g, '');

  // Try to extract key facts from the extract text (simple pattern matching)
  const facts = {};

  // Look for population
  const popMatch = extract.match(/population[^\d]*([\d,]+)/i);
  if (popMatch) {
    facts.Population = popMatch[1];
  }

  // Look for country
  const countryMatch = extract.match(/\bin\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)\s*[,.]|is\s+(?:the\s+)?(?:capital|city|located)\s+(?:of|in)\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)/);
  if (countryMatch) {
    facts.Country = countryMatch[1] || countryMatch[2];
  }

  return {
    title: firstResult.title,
    extract: extract.substring(0, 800) + (extract.length > 800 ? '...' : ''),
    url: `https://en.wikipedia.org/wiki/${encodeURIComponent(firstResult.title.replace(/ /g, '_'))}`,
    facts
  };
}

async function startWorker() {
  const connection = await amqplib.connect(RABBITMQ_URL);
  const channel = await connection.createChannel();

  await channel.assertExchange(EXCHANGE_NAME, 'topic', { durable: true });

  const { queue } = await channel.assertQueue('', { exclusive: true });
  await channel.bindQueue(queue, EXCHANGE_NAME, 'search.request.*');

  console.log('📚 Wikipedia worker started, listening for search requests...');

  channel.consume(queue, async (msg) => {
    if (!msg) return;

    try {
      const { searchId, query } = JSON.parse(msg.content.toString());
      console.log(`📚 Fetching Wikipedia info for ${query}...`);

      const wikiData = await fetchWikipedia(query);

      if (wikiData) {
        const results = [
          {
            id: `wiki-${searchId}`,
            type: 'markdown',
            title: `About ${wikiData.title}`,
            data: `${wikiData.extract}\n\n[Read more on Wikipedia](${wikiData.url})`
          }
        ];

        // Add city facts if we found any
        if (Object.keys(wikiData.facts).length > 0) {
          results.push({
            id: `facts-${searchId}`,
            type: 'keyvalue',
            title: 'City Facts',
            data: wikiData.facts
          });
        }

        const result = {
          searchId,
          source: 'wikipedia',
          results
        };

        channel.publish(
          EXCHANGE_NAME,
          `search.results.${searchId}`,
          Buffer.from(JSON.stringify(result))
        );

        console.log(`✅ Wikipedia data sent for ${query}`);
      } else {
        console.log(`⚠️  No Wikipedia results for ${query}`);
      }

      channel.ack(msg);
    } catch (error) {
      console.error('❌ Wikipedia worker error:', error);
      channel.nack(msg, false, false);
    }
  });
}

startWorker().catch(console.error);
