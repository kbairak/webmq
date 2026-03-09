import { v4 as uuid } from 'uuid';
import ReconnectingWebSocket from '../src/ReconnectingWebSocket';
import WebMQClient, { ClientMessageHeader, MessageHeader } from '../src';
import { bundleData, unbundleData } from '../src/bundle';
import { createMockWebSocket } from './utils';

jest.mock('uuid');
jest.mock('../src/ReconnectingWebSocket');

const mockUuid = uuid as jest.Mock;
const MockReconnectingWebSocket = ReconnectingWebSocket as jest.Mock;

describe('WebMQClient', () => {
  let mockWs: ReturnType<typeof createMockWebSocket>;
  let uuidCounter: number;

  beforeEach(() => {
    jest.clearAllMocks();
    uuidCounter = 1;
    mockUuid.mockImplementation(() => `uuid_${uuidCounter++}`);
    mockWs = createMockWebSocket();
    MockReconnectingWebSocket.mockImplementation(() => mockWs);
  });

  it('should connect', async () => {
    const c = new WebMQClient({ url: 'dumb_url', sessionId: 'dumb_sessionid', logLevel: 'SILENT' });
    c.connect();

    expect(MockReconnectingWebSocket).toHaveBeenCalledWith(
      'dumb_url',
      [0, 1000, 2000, 4000, 8000]
    );
    expect(mockWs.addEventListener).toHaveBeenCalledTimes(6);

    // Simulate WebSocket open
    mockWs.dispatchEvent(new Event('open'));

    // Wait for async hooks to complete
    await new Promise((resolve) => setTimeout(resolve, 0));

    // Verify identify was sent
    expect(mockWs.send).toHaveBeenCalledTimes(1);
    const sentData = mockWs.send.mock.calls.at(-1)[0];
    expect(sentData).toBeInstanceOf(ArrayBuffer);
    const [header, payload] = unbundleData(sentData);
    expect(header).toEqual({
      action: 'identify',
      messageId: 'uuid_1',
      sessionId: 'dumb_sessionid',
    });
    const payloadText = new TextDecoder().decode(payload);
    expect(payloadText).toEqual('');
  });

  async function getIdentifiedClient() {
    const c = new WebMQClient({ url: 'dumb_url', sessionId: 'dumb_sessionid', logLevel: 'SILENT' });
    c.connect();
    mockWs.dispatchEvent(new Event('open'));
    // Wait for identify to be sent
    await new Promise((resolve) => setTimeout(resolve, 0));
    return c;
  }

  it('should publish', async () => {
    const c = await getIdentifiedClient();

    c.publish('dumb_routing_key', {
      data: 'dumb_payload',
    });

    // Wait for async hooks to complete
    await new Promise((resolve) => setTimeout(resolve, 0));

    // Verify send was called
    expect(mockWs.send).toHaveBeenCalledTimes(2);

    // Extract and verify the actual sent data
    const sentData = mockWs.send.mock.calls.at(-1)[0];
    expect(sentData).toBeInstanceOf(ArrayBuffer);

    // Unbundle to verify contents
    const [header, payload] = unbundleData(sentData);

    expect(header).toEqual({
      action: 'publish',
      routingKey: 'dumb_routing_key',
      messageId: 'uuid_2',
    });
    const payloadText = new TextDecoder().decode(payload);
    expect(JSON.parse(payloadText)).toEqual({ data: 'dumb_payload' });
  });

  it('should listen', async () => {
    const c = await getIdentifiedClient();

    const callback = jest.fn();
    c.listen('dumb_binding_key', callback);

    expect(
      [...(c as any)._messageListeners.get('dumb_binding_key')][0]
    ).toEqual([callback, true]);

    // Wait for async hooks to complete
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(mockWs.send).toHaveBeenCalledTimes(2);
    const sentData = mockWs.send.mock.calls.at(-1)[0];
    expect(sentData).toBeInstanceOf(ArrayBuffer);
    const [header, payload] = unbundleData(sentData);
    expect(header).toEqual({
      action: 'listen',
      bindingKey: 'dumb_binding_key',
      messageId: 'uuid_2',
    });
    const payloadText = new TextDecoder().decode(payload);
    expect(payloadText).toEqual('');
  });

  it('should not send listen message if bindingKey already exists', async () => {
    const c = await getIdentifiedClient();
    const [callback1, callback2] = [jest.fn(), jest.fn()];
    (c as any)._messageListeners.set(
      'dumb_binding_key',
      new Map([[callback1, true]])
    );
    c.listen('dumb_binding_key', callback2);
    expect(mockWs.send).toHaveBeenCalledTimes(1); // Only the identify message
    expect((c as any)._messageListeners.get('dumb_binding_key').size).toEqual(
      2
    );
    expect(
      (c as any)._messageListeners.get('dumb_binding_key').get(callback2)
    ).toBeTruthy();
  });

  it('should unlisten', async () => {
    const c = await getIdentifiedClient();
    const callback = jest.fn();
    (c as any)._messageListeners.set(
      'dumb_binding_key',
      new Map([[callback, true]])
    );
    c.unlisten('dumb_binding_key', callback);
    expect((c as any)._messageListeners.size).toEqual(0);

    // Wait for async hooks to complete
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(mockWs.send).toHaveBeenCalledTimes(2);
    const sentData = mockWs.send.mock.calls.at(-1)[0];
    expect(sentData).toBeInstanceOf(ArrayBuffer);
    const [header, payload] = unbundleData(sentData);
    expect(header).toEqual({
      action: 'unlisten',
      bindingKey: 'dumb_binding_key',
      messageId: 'uuid_2',
    });
    const payloadText = new TextDecoder().decode(payload);
    expect(payloadText).toEqual('');
  });

  it('should not send unlisten message if more than one callbacks', async () => {
    const c = await getIdentifiedClient();
    const [callback1, callback2] = [jest.fn(), jest.fn()];
    (c as any)._messageListeners.set(
      'dumb_binding_key',
      new Map([
        [callback1, true],
        [callback2, true],
      ])
    );
    c.unlisten('dumb_binding_key', callback2);
    expect(
      (c as any)._messageListeners.get('dumb_binding_key').has(callback1)
    ).toBeTruthy();
    expect(
      (c as any)._messageListeners.get('dumb_binding_key').has(callback2)
    ).toBeFalsy();
    expect(mockWs.send).toHaveBeenCalledTimes(1); // Only the identify message
  });

  it('should receive message', async () => {
    const c = await getIdentifiedClient();
    const callback = jest.fn();
    (c as any)._messageListeners.set(
      'dumb_binding_key',
      new Map([[callback, true]])
    );
    mockWs.dispatchEvent(
      new MessageEvent('message', {
        data: bundleData(
          { action: 'message', routingKey: 'dumb_binding_key' },
          new TextEncoder().encode(JSON.stringify({ hello: 'world' })).buffer
        ),
      })
    );
    expect(callback).toHaveBeenCalledWith({ hello: 'world' });
  });

  it('should disconnect', async () => {
    const c = await getIdentifiedClient();
    c.disconnect();
    expect(mockWs.close).toHaveBeenCalledTimes(1);
  });

  it('should reconnect', async () => {
    const c = await getIdentifiedClient();
    mockWs.dispatchEvent(new Event('reconnecting'));
    mockWs.dispatchEvent(new Event('reconnected'));

    // Wait for async hooks to complete
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(mockWs.send).toHaveBeenCalledTimes(2); // identify message should be resent
    const sentData = mockWs.send.mock.calls.at(-1)[0];
    expect(sentData).toBeInstanceOf(ArrayBuffer);
    const [header, payload] = unbundleData(sentData);
    expect(header).toEqual({
      action: 'identify',
      sessionId: 'dumb_sessionid',
      messageId: 'uuid_1', // Same ID from connect() closure
    });
    const payloadText = new TextDecoder().decode(payload);
    expect(payloadText).toEqual('');
  });

  it('should queue messages while reconnecting', async () => {
    const c = await getIdentifiedClient();
    // Start reconnect - set readyState to CONNECTING so messages get queued
    (mockWs as any).readyState = WebSocket.CONNECTING;
    mockWs.dispatchEvent(new Event('reconnecting'));
    // Attempt publish
    c.publish('dumb_routing_key', { hello: 'world' });
    // Verify message is queued
    expect((c as any)._messageQueue.length).toEqual(1);
    expect((c as any)._messageQueue[0].header).toEqual({
      action: 'publish',
      messageId: 'uuid_2',
      routingKey: 'dumb_routing_key',
    });
    let payload = (c as any)._messageQueue[0].payload;
    let payloadText = new TextDecoder().decode(payload);
    expect(JSON.parse(payloadText)).toEqual({ hello: 'world' });
    // Complete reconnect
    (mockWs as any).readyState = WebSocket.OPEN;
    mockWs.dispatchEvent(new Event('reconnected'));

    // Wait for async hooks to complete
    await new Promise((resolve) => setTimeout(resolve, 0));

    // Verify identify is resent and queued publish is sent
    expect(mockWs.send).toHaveBeenCalledTimes(3); // identify x2 + publish

    // Check the reconnect identify message (second-to-last call)
    let identifyData = mockWs.send.mock.calls.at(-2)[0];
    expect(identifyData).toBeInstanceOf(ArrayBuffer);
    let [identifyHeader, identifyPayload] = unbundleData(identifyData);
    expect(identifyHeader).toEqual({
      action: 'identify',
      sessionId: 'dumb_sessionid',
      messageId: 'uuid_1', // Same ID from connect() closure
    });
    expect(new TextDecoder().decode(identifyPayload)).toEqual('');

    // Check the queued publish message (last call)
    let publishData = mockWs.send.mock.calls.at(-1)[0];
    expect(publishData).toBeInstanceOf(ArrayBuffer);
    let [publishHeader, publishPayload] = unbundleData(publishData);
    expect(publishHeader).toEqual({
      action: 'publish',
      routingKey: 'dumb_routing_key',
      messageId: 'uuid_3', // New ID generated when flushing queue
    });
    expect(JSON.parse(new TextDecoder().decode(publishPayload))).toEqual({ hello: 'world' });
  });

  it('should apply identify hook', async () => {
    const c = new WebMQClient({ url: 'dumb_url', sessionId: 'dumb_sessionid', logLevel: 'SILENT' });

    const onIdentify = (header: ClientMessageHeader): ClientMessageHeader => {
      return { ...header, identify: 'hook' };
    };
    c.addHook('identify', onIdentify);
    expect((c as any)._hooks.identify).toContain(onIdentify);

    c.connect();
    mockWs.dispatchEvent(new Event('open'));

    // Wait for async hooks to complete
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(mockWs.send).toHaveBeenCalledTimes(1);
    const sentData = mockWs.send.mock.calls.at(-1)[0];
    expect(sentData).toBeInstanceOf(ArrayBuffer);
    const [header, payload] = unbundleData(sentData);
    expect(header).toEqual({
      action: 'identify',
      messageId: 'uuid_1',
      sessionId: 'dumb_sessionid',
      identify: 'hook',
    });
    const payloadText = new TextDecoder().decode(payload);
    expect(payloadText).toEqual('');
  });

  it('should apply pre hook to identify', async () => {
    const c = new WebMQClient({ url: 'dumb_url', sessionId: 'dumb_sessionid', logLevel: 'SILENT' });

    const onIdentify = (header: MessageHeader): MessageHeader => {
      return { ...header, pre: 'hook' };
    };
    c.addHook('pre', onIdentify);
    expect((c as any)._hooks.pre).toContain(onIdentify);

    c.connect();
    mockWs.dispatchEvent(new Event('open'));

    // Wait for async hooks to complete
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(mockWs.send).toHaveBeenCalledTimes(1);
    const sentData = mockWs.send.mock.calls.at(-1)[0];
    expect(sentData).toBeInstanceOf(ArrayBuffer);
    const [header, payload] = unbundleData(sentData);
    expect(header).toEqual({
      action: 'identify',
      messageId: 'uuid_1',
      sessionId: 'dumb_sessionid',
      pre: 'hook',
    });
    const payloadText = new TextDecoder().decode(payload);
    expect(payloadText).toEqual('');
  });

  it('should should apply publish hook', async () => {
    const c = await getIdentifiedClient();
    const onPublish = (header: ClientMessageHeader): ClientMessageHeader => {
      return { ...header, publish: 'hook' };
    };
    c.addHook('publish', onPublish);
    expect((c as any)._hooks.publish).toContain(onPublish);

    c.publish('dumb_routing_key', { data: 'dumb_payload' });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(mockWs.send).toHaveBeenCalledTimes(2);
    const sentData = mockWs.send.mock.calls.at(-1)[0];
    expect(sentData).toBeInstanceOf(ArrayBuffer);
    const [header, payload] = unbundleData(sentData);
    expect(header).toEqual({
      action: 'publish',
      routingKey: 'dumb_routing_key',
      messageId: 'uuid_2',
      publish: 'hook',
    });
    const payloadText = new TextDecoder().decode(payload);
    expect(JSON.parse(payloadText)).toEqual({ data: 'dumb_payload' });
  });

  it('should should apply pre hook to publish', async () => {
    const c = await getIdentifiedClient();
    const onPublish = (header: MessageHeader): MessageHeader => {
      return { ...header, pre: 'hook' };
    };
    c.addHook('pre', onPublish);
    expect((c as any)._hooks.pre).toContain(onPublish);

    c.publish('dumb_routing_key', { data: 'dumb_payload' });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(mockWs.send).toHaveBeenCalledTimes(2);
    const sentData = mockWs.send.mock.calls.at(-1)[0];
    expect(sentData).toBeInstanceOf(ArrayBuffer);
    const [header, payload] = unbundleData(sentData);
    expect(header).toEqual({
      action: 'publish',
      routingKey: 'dumb_routing_key',
      messageId: 'uuid_2',
      pre: 'hook',
    });
    const payloadText = new TextDecoder().decode(payload);
    expect(JSON.parse(payloadText)).toEqual({ data: 'dumb_payload' });
  });

  it('should remove hook', () => {
    const c = new WebMQClient({ url: 'dumb_url', sessionId: 'dumb_sessionid', logLevel: 'SILENT' });
    const onIdentify = jest.fn();
    c.addHook('identify', onIdentify);
    expect((c as any)._hooks.identify).toContain(onIdentify);
    c.removeHook('identify', onIdentify);
    expect((c as any)._hooks.identify).not.toContain(onIdentify);
  });
});
