import asyncio
import json

import aio_pika


async def main():
    connection = await aio_pika.connect_robust(
        "amqp://guest:guest@localhost/",
    )

    async with connection:
        channel = await connection.channel()

        exchange = await channel.declare_exchange(
            "webmq_exchange", aio_pika.ExchangeType.TOPIC, durable=False
        )

        # Declare a queue for order requests and bind it to the exchange
        queue = await channel.declare_queue("create_buy_order", durable=True)
        await queue.bind(exchange, "actions.*.stock_order_service.buy_orders.create")

        print(" [*] Python Worker: Waiting for order requests. To exit press CTRL+C")

        async with queue.iterator() as queue_iterator:
            async for message in queue_iterator:
                async with message.process():
                    try:
                        order = json.loads(message.body.decode())
                        print(f" [x] Python Worker: Received {order=}")
                        await exchange.publish(
                            aio_pika.Message(
                                body=json.dumps(order).encode(),
                                content_type="application/json",
                            ),
                            routing_key=f"events.stock_order_service.buy_orders.created.{order['id']}",
                        )

                        # Simulate processing time
                        await asyncio.sleep(2)

                        order["units"] = order["amount_gbp"] / 400
                        await exchange.publish(
                            aio_pika.Message(
                                body=json.dumps(order).encode(),
                                content_type="application/json",
                            ),
                            routing_key=f"events.stock_order_service.buy_orders.updated.{order['id']}",
                        )

                        # Simulate processing time
                        await asyncio.sleep(2)

                        order["amount_usd"] = order["amount_gbp"] * 1.1
                        await exchange.publish(
                            aio_pika.Message(
                                body=json.dumps(order).encode(),
                                content_type="application/json",
                            ),
                            routing_key=f"events.stock_order_service.buy_orders.updated.{order['id']}",
                        )

                    except Exception as e:
                        print(f" [!] Python Worker: Error processing message: {e}")


if __name__ == "__main__":
    asyncio.run(main())
