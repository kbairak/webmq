# Cross-Language Workers

The killer feature of WebMQ: **workers can be written in any language** that speaks AMQP. They don't need WebMQ, they don't need Node.js — just a RabbitMQ client library.

The pattern is always the same:

1. Connect to RabbitMQ
2. Assert the exchange exists (same name as your WebMQ backend uses)
3. Create an exclusive queue
4. Bind the queue to the exchange with a topic pattern
5. Consume messages
6. Publish results back

## Python (aio_pika)

```python
import asyncio, json
import aio_pika

async def main():
    connection = await aio_pika.connect_robust("amqp://localhost")
    async with connection:
        channel = await connection.channel()
        exchange = await channel.get_exchange("city_search")

        # Exclusive queue — auto-deleted when worker disconnects
        queue = await channel.declare_queue(exclusive=True)
        await queue.bind(exchange, "search.request.*")

        async with queue.iterator() as queue_iter:
            async for message in queue_iter:
                async with message.process():
                    data = json.loads(message.body)
                    search_id = data["searchId"]
                    query = data["query"]

                    # Do your work...
                    result = {"temperature": 22, "humidity": 60}

                    # Publish result back
                    await channel.default_exchange.publish(
                        aio_pika.Message(
                            body=json.dumps({
                                "searchId": search_id,
                                "source": "weather",
                                "data": result
                            }).encode()
                        ),
                        routing_key=f"search.results.{search_id}"
                    )

asyncio.run(main())
```

## Python (pika — synchronous)

```python
import pika, json

connection = pika.BlockingConnection(pika.ConnectionParameters("localhost"))
channel = connection.channel()

channel.exchange_declare(exchange="city_search", exchange_type="topic", durable=True)
result = channel.queue_declare(queue="", exclusive=True)
queue_name = result.method.queue

channel.queue_bind(exchange="city_search", queue=queue_name, routing_key="search.request.*")

def callback(ch, method, properties, body):
    data = json.loads(body)
    # Process and publish result...

channel.basic_consume(queue=queue_name, on_message_callback=callback, auto_ack=True)
channel.start_consuming()
```

## Go

```go
package main

import (
    "context"
    "encoding/json"
    "log"
    "github.com/rabbitmq/amqp091-go"
)

func main() {
    conn, _ := amqp091.Dial("amqp://localhost")
    defer conn.Close()

    ch, _ := conn.Channel()
    defer ch.Close()

    ch.ExchangeDeclare("city_search", "topic", true, false, false, false, nil)
    q, _ := ch.QueueDeclare("", false, false, true, false, nil)
    ch.QueueBind(q.Name, "search.request.*", "city_search", false, nil)

    msgs, _ := ch.Consume(q.Name, "", true, false, false, false, nil)

    for msg := range msgs {
        var data map[string]interface{}
        json.Unmarshal(msg.Body, &data)

        result := map[string]interface{}{
            "searchId": data["searchId"],
            "source":   "go-worker",
            "data":     map[string]string{"status": "processed"},
        }
        body, _ := json.Marshal(result)
        ch.PublishWithContext(context.Background(),
            "city_search", "search.results." + data["searchId"].(string),
            false, false,
            amqp091.Publishing{ContentType: "application/json", Body: body})
    }
}
```

## Java

```java
import com.rabbitmq.client.*;

public class Worker {
    public static void main(String[] args) throws Exception {
        ConnectionFactory factory = new ConnectionFactory();
        factory.setHost("localhost");
        try (Connection conn = factory.newConnection();
             Channel ch = conn.createChannel()) {

            ch.exchangeDeclare("city_search", "topic", true);
            String queue = ch.queueDeclare().getQueue();
            ch.queueBind(queue, "city_search", "search.request.*");

            DeliverCallback callback = (consumerTag, delivery) -> {
                String body = new String(delivery.getBody(), "UTF-8");
                // Process and publish result...
                ch.basicAck(delivery.getEnvelope().getDeliveryTag(), false);
            };

            ch.basicConsume(queue, false, callback, consumerTag -> {});
        }
    }
}
```

## Ruby

```ruby
require 'bunny'
require 'json'

connection = Bunny.new
connection.start
channel = connection.create_channel

exchange = channel.topic('city_search', durable: true)
queue = channel.queue('', exclusive: true)
queue.bind(exchange, routing_key: 'search.request.*')

queue.subscribe(manual_ack: true) do |delivery_info, properties, body|
  data = JSON.parse(body)
  result = { searchId: data['searchId'], source: 'ruby', data: {} }
  exchange.publish(JSON.generate(result),
                   routing_key: "search.results.#{data['searchId']}")
  channel.ack(delivery_info.delivery_tag)
end

sleep
```

## .NET (C#)

```csharp
using RabbitMQ.Client;
using RabbitMQ.Client.Events;
using System.Text;
using System.Text.Json;

var factory = new ConnectionFactory { HostName = "localhost" };
using var conn = factory.CreateConnection();
using var channel = conn.CreateModel();

channel.ExchangeDeclare("city_search", "topic", durable: true);
var queue = channel.QueueDeclare(exclusive: true);
channel.QueueBind(queue.QueueName, "city_search", "search.request.*");

var consumer = new EventingBasicConsumer(channel);
consumer.Received += (model, ea) =>
{
    var body = JsonSerializer.Deserialize<Dictionary<string, JsonElement>>(
        Encoding.UTF8.GetString(ea.Body.Span));
    var searchId = body["searchId"].GetString();
    var result = new { searchId, source = "dotnet", data = new { } };
    channel.BasicPublish("city_search",
        $"search.results.{searchId}", body: Encoding.UTF8.GetBytes(
            JsonSerializer.Serialize(result)));
    channel.BasicAck(ea.DeliveryTag, false);
};

channel.BasicConsume(queue.QueueName, false, consumer);
Console.ReadLine();
```

## AMQP libraries by language

| Language | Library |
|---|---|
| Python | `aio_pika` (async), `pika` (sync) |
| Go | `github.com/rabbitmq/amqp091-go` |
| Java | `com.rabbitmq:amqp-client` |
| Ruby | `bunny` |
| .NET / C# | `RabbitMQ.Client` |
| Rust | `lapin` |
| PHP | `php-amqplib/php-amqplib` |
| Elixir | `AMQP` |

## Worker pattern summary

```
Frontend                    WebMQ Backend         RabbitMQ              Worker
   │                             │                    │                    │
   │── publish('tasks.req.1') ──>│                    │                    │
   │                             │── publish ────────>│                    │
   │                             │                    │── route ──────────>│
   │                             │                    │                    │── process
   │                             │                    │<── publish result ─│
   │                             │<── route ─────────│                    │
   │<── forward result ─────────│                    │                    │
```

Any service can publish to any routing key. Workers consume relevant topics and publish results. The frontend listens for results using a unique binding key (e.g., `tasks.results.1`). This decoupling means you can add, remove, or update workers without touching the frontend or the WebMQ backend.
