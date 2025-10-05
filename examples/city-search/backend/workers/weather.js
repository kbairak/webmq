import amqplib from 'amqplib';

const RABBITMQ_URL = 'amqp://localhost';
const EXCHANGE_NAME = 'city_search';

async function geocode(cityName) {
  const url = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(cityName)}&count=1&language=en&format=json`;
  const response = await fetch(url);
  const data = await response.json();

  if (!data.results || data.results.length === 0) {
    throw new Error(`City not found: ${cityName}`);
  }

  return {
    lat: data.results[0].latitude,
    lon: data.results[0].longitude
  };
}

async function fetchWeather(lat, lon) {
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current=temperature_2m,relative_humidity_2m,wind_speed_10m,weather_code&temperature_unit=celsius&wind_speed_unit=kmh`;

  const response = await fetch(url);
  const data = await response.json();

  if (!data.current) {
    console.error('Weather API response:', data);
    throw new Error(`Weather API error: ${data.reason || 'No current weather data'}`);
  }

  const weatherCodes = {
    0: 'Clear sky',
    1: 'Mainly clear',
    2: 'Partly cloudy',
    3: 'Overcast',
    45: 'Foggy',
    48: 'Rime fog',
    51: 'Light drizzle',
    61: 'Light rain',
    63: 'Moderate rain',
    65: 'Heavy rain',
    71: 'Light snow',
    73: 'Moderate snow',
    75: 'Heavy snow',
    95: 'Thunderstorm'
  };

  const current = data.current;
  return {
    Temperature: `${Math.round(current.temperature_2m)}°C`,
    Conditions: weatherCodes[current.weather_code] || 'Unknown',
    'Wind Speed': `${Math.round(current.wind_speed_10m)} km/h`,
    Humidity: `${current.relative_humidity_2m}%`
  };
}

async function startWorker() {
  const connection = await amqplib.connect(RABBITMQ_URL);
  const channel = await connection.createChannel();

  await channel.assertExchange(EXCHANGE_NAME, 'topic', { durable: true });

  const { queue } = await channel.assertQueue('', { exclusive: true });
  await channel.bindQueue(queue, EXCHANGE_NAME, 'search.request.*');

  console.log('🌤️  Weather worker started, listening for search requests...');

  channel.consume(queue, async (msg) => {
    if (!msg) return;

    try {
      const { searchId, query } = JSON.parse(msg.content.toString());
      console.log(`🌤️  Fetching weather for ${query}...`);

      const { lat, lon } = await geocode(query);
      console.log(`🌤️  Coordinates: ${lat}, ${lon}`);
      const weatherData = await fetchWeather(lat, lon);

      const result = {
        searchId,
        source: 'weather',
        results: [
          {
            id: `weather-${searchId}`,
            type: 'keyvalue',
            title: 'Current Weather',
            data: weatherData
          },
          {
            id: `coordinates-${searchId}`,
            type: 'keyvalue',
            title: 'Coordinates',
            data: {
              Latitude: lat.toFixed(4),
              Longitude: lon.toFixed(4)
            }
          }
        ]
      };

      channel.publish(
        EXCHANGE_NAME,
        `search.results.${searchId}`,
        Buffer.from(JSON.stringify(result))
      );

      console.log(`✅ Weather data sent for ${query}`);
      channel.ack(msg);
    } catch (error) {
      console.error('❌ Weather worker error:', error);
      channel.nack(msg, false, false);
    }
  });
}

startWorker().catch(console.error);
