import promClient from 'prom-client';

export const wsConnections = new promClient.Gauge({
  name: 'webmq_websocket_connections',
  help: 'Number of active WebSocket connections',
});

export const rmqConsumers = new promClient.Gauge({
  name: 'webmq_rabbitmq_consumers',
  help: 'Number of active RabbitMQ consumers',
});

export const wsMessagesReceived = new promClient.Counter({
  name: 'webmq_websocket_messages_received_total',
  help: 'Total number of messages received from WebSocket clients',
  labelNames: ['action'],
});

export const wsMessagesAcked = new promClient.Counter({
  name: 'webmq_websocket_messages_acked_total',
  help: 'Total number of messages acknowledged to WebSocket clients',
  labelNames: ['action'],
});

export const wsMessagesNacked = new promClient.Counter({
  name: 'webmq_websocket_messages_nacked_total',
  help: 'Total number of messages negatively acknowledged to WebSocket clients',
  labelNames: ['action'],
});

export const rmqConsecutiveFailures = new promClient.Gauge({
  name: 'webmq_rabbitmq_consecutive_channel_failures',
  help: 'Number of consecutive RabbitMQ channel failures',
});

export const wsToRmqPublishes = new promClient.Counter({
  name: 'webmq_websocket_to_rabbitmq_publishes_total',
  help: 'Total number of messages published from WebSocket to RabbitMQ',
  labelNames: ['routing_key'],
});

export const rmqBindings = new promClient.Gauge({
  name: 'webmq_rabbitmq_bindings',
  help: 'Number of active RabbitMQ bindings (listen actions)',
  labelNames: ['binding_key'],
});

export const rmqToWsPublishes = new promClient.Counter({
  name: 'webmq_rabbitmq_to_websocket_publishes_total',
  help: 'Total number of messages published from RabbitMQ to WebSocket clients',
  labelNames: ['routing_key'],
});

export const rmqMessagesAcked = new promClient.Counter({
  name: 'webmq_rabbitmq_messages_acked_total',
  help: 'Total number of RabbitMQ messages acknowledged successfully to WebSocket clients',
  labelNames: ['routing_key'],
});

export const rmqMessagesNacked = new promClient.Counter({
  name: 'webmq_rabbitmq_messages_nacked_total',
  help: 'Total number of RabbitMQ messages negatively acknowledged to RabbitMQ',
  labelNames: ['routing_key'],
});

export const errors = new promClient.Counter({
  name: 'webmq_errors_total',
  help: 'Total number of errors encountered in the WebMQ server',
  labelNames: ['type', 'action'],
});
