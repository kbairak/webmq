import amqplib from 'amqplib';

const RABBITMQ_URL = 'amqp://localhost';
const EXCHANGE_NAME = 'city_search';

async function fetchImages(query) {
  const searchUrl = `https://commons.wikimedia.org/w/api.php?action=query&generator=search&gsrsearch=${encodeURIComponent(query)}&gsrnamespace=6&gsrlimit=6&prop=imageinfo&iiprop=url|extmetadata&iiurlwidth=400&format=json&origin=*`;

  const response = await fetch(searchUrl);
  const data = await response.json();

  if (!data.query || !data.query.pages) {
    return [];
  }

  const images = [];
  for (const pageId in data.query.pages) {
    const page = data.query.pages[pageId];
    if (page.imageinfo && page.imageinfo[0]) {
      const info = page.imageinfo[0];
      const metadata = info.extmetadata;

      images.push({
        url: info.url,
        thumbUrl: info.thumburl || info.url,
        title: page.title.replace('File:', ''),
        description: metadata?.ImageDescription?.value?.replace(/<[^>]*>/g, '') || '',
        author: metadata?.Artist?.value?.replace(/<[^>]*>/g, '') || 'Unknown'
      });
    }
  }

  return images.slice(0, 4); // Limit to 4 images
}

async function startWorker() {
  const connection = await amqplib.connect(RABBITMQ_URL);
  const channel = await connection.createChannel();

  await channel.assertExchange(EXCHANGE_NAME, 'topic', { durable: true });

  const { queue } = await channel.assertQueue('', { exclusive: true });
  await channel.bindQueue(queue, EXCHANGE_NAME, 'search.request.*');

  console.log('🖼️  Images worker started, listening for search requests...');

  channel.consume(queue, async (msg) => {
    if (!msg) return;

    try {
      const { searchId, query } = JSON.parse(msg.content.toString());
      console.log(`🖼️  Fetching images for ${query}...`);

      const images = await fetchImages(query);

      if (images.length > 0) {
        const results = images.map((img, idx) => ({
          id: `image-${searchId}-${idx}`,
          type: 'image',
          title: img.title,
          data: {
            url: img.url,
            thumbUrl: img.thumbUrl,
            caption: img.description || img.title,
            author: img.author
          }
        }));

        const result = {
          searchId,
          source: 'images',
          results
        };

        channel.publish(
          EXCHANGE_NAME,
          `search.results.${searchId}`,
          Buffer.from(JSON.stringify(result))
        );

        console.log(`✅ ${images.length} images sent for ${query}`);
      } else {
        console.log(`⚠️  No images found for ${query}`);
      }

      channel.ack(msg);
    } catch (error) {
      console.error('❌ Images worker error:', error);
      channel.nack(msg, false, false);
    }
  });
}

startWorker().catch(console.error);
