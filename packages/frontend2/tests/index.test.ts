import { v4 as uuid } from 'uuid';
import ReconnectingWebSocket from '../src/ReconnectingWebSocket';
import WebMQClient, { ClientMessageHeader, MessageHeader } from '../src';
import { bundleData, unbundleData } from '../src/bundle';
import { createMockWebSocket } from './utils'

jest.mock('uuid');
jest.mock('../src/ReconnectingWebSocket')

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
    const c = new WebMQClient({ url: 'dumb_url', sessionId: 'dumb_sessionid' });
    const connectPromise = c.connect();
    expect(MockReconnectingWebSocket).toHaveBeenCalledWith('dumb_url', [0, 1000, 2000, 4000, 8000]);
    expect(mockWs.addEventListener).toHaveBeenCalledTimes(6);

    // Simulate WebSocket open
    mockWs.dispatchEvent(new Event('open'));

    // Wait for async hooks to complete
    await new Promise(resolve => setTimeout(resolve, 0));

    // Verify identify was sent
    expect(mockWs.send).toHaveBeenCalledTimes(1);
    const sentData = mockWs.send.mock.calls.at(-1)[0];
    expect(sentData).toBeInstanceOf(ArrayBuffer);
    const [header, payload] = unbundleData(sentData);
    expect(header).toEqual({
      action: 'identify', messageId: 'uuid_1', sessionId: 'dumb_sessionid'
    });
    const payloadText = new TextDecoder().decode(payload);
    expect(payloadText).toEqual('');

    // Simulate ack response to resolve the promise
    mockWs.dispatchEvent(new MessageEvent('message', {
      data: bundleData({ action: 'ack', messageId: 'uuid_1' })
    }));

    // Now the promise should resolve
    await connectPromise;
  });

  it('should reject connect on error', async () => {
    const c = new WebMQClient({ url: 'dumb_url', sessionId: 'dumb_sessionid' });
    const connectPromise = c.connect();
    mockWs.dispatchEvent(new Event('error'));
    let raised = false;
    try {
      await connectPromise;
    } catch (err) {
      raised = true;
    }
    expect(raised).toBeTruthy();
  });

  it('should reject connect on close', async () => {
    const c = new WebMQClient({ url: 'dumb_url', sessionId: 'dumb_sessionid' });
    const connectPromise = c.connect();
    mockWs.dispatchEvent(new Event('close'));
    let raised = false;
    try {
      await connectPromise;
    } catch (err) {
      raised = true;
    }
    expect(raised).toBeTruthy();
  });

  async function getIdentifiedClient() {
    const c = new WebMQClient({ url: 'dumb_url', sessionId: 'dumb_sessionid' });
    const connectPromise = c.connect();
    mockWs.dispatchEvent(new Event('open'));
    mockWs.dispatchEvent(new MessageEvent('message', {
      data: bundleData({ action: 'ack', messageId: 'uuid_1' })
    }));
    await connectPromise;
    return c;
  }

  it('should publish', async () => {
    const c = await getIdentifiedClient();

    const publishPromise = c.publish('dumb_routing_key', { data: 'dumb_payload' });
    expect((c as any)._pendingMessages.has('uuid_2')).toBeTruthy();

    // Wait for async hooks to complete
    await new Promise(resolve => setTimeout(resolve, 0));

    // Verify send was called
    expect(mockWs.send).toHaveBeenCalledTimes(2);

    // Extract and verify the actual sent data
    const sentData = mockWs.send.mock.calls.at(-1)[0];
    expect(sentData).toBeInstanceOf(ArrayBuffer);

    // Unbundle to verify contents
    const [header, payload] = unbundleData(sentData);

    expect(header).toEqual({
      action: 'publish', routingKey: 'dumb_routing_key', messageId: 'uuid_2'
    });
    const payloadText = new TextDecoder().decode(payload);
    expect(JSON.parse(payloadText)).toEqual({ data: 'dumb_payload' });
    mockWs.dispatchEvent(new MessageEvent(
      'message',
      { data: bundleData({ action: 'ack', messageId: 'uuid_2' }) },
    ));

    await publishPromise;
  });

  it('should reject publish on nack', async () => {
    const c = await getIdentifiedClient();
    const publishPromise = c.publish('dumb_routing_key', { data: 'dumb_payload' });
    mockWs.dispatchEvent(new MessageEvent(
      'message',
      { data: bundleData({ action: 'nack', messageId: 'uuid_2' }) },
    ));
    let raised = false;
    try {
      await publishPromise;
    } catch (err) {
      raised = true;
    }
    expect(raised).toBeTruthy();
  });

  it('should listen', async () => {
    const c = await getIdentifiedClient();

    const callback = jest.fn();
    const listenPromise = c.listen('dumb_binding_key', callback)
    await new Promise(resolve => setTimeout(resolve, 0));
    expect([...(c as any)._messageListeners.get('dumb_binding_key')][0]).toEqual([callback, true]);

    // Wait for async hooks to complete
    await new Promise(resolve => setTimeout(resolve, 0));

    expect(mockWs.send).toHaveBeenCalledTimes(2);
    const sentData = mockWs.send.mock.calls.at(-1)[0];
    expect(sentData).toBeInstanceOf(ArrayBuffer);
    const [header, payload] = unbundleData(sentData);
    expect(header).toEqual({
      action: 'listen', bindingKey: 'dumb_binding_key', messageId: 'uuid_2'
    });
    const payloadText = new TextDecoder().decode(payload);
    expect(payloadText).toEqual('');
    mockWs.dispatchEvent(new MessageEvent(
      'message',
      { data: bundleData({ action: 'ack', messageId: 'uuid_2' }) },
    ));
    await listenPromise;
  });

  it('should not send listen message if bindingKey already exists', async () => {
    const c = await getIdentifiedClient();
    const [callback1, callback2] = [jest.fn(), jest.fn()];
    (c as any)._messageListeners.set('dumb_binding_key', new Map([[callback1, true]]));
    await c.listen('dumb_binding_key', callback2);
    expect(mockWs.send).toHaveBeenCalledTimes(1); // Only the identify message
    expect((c as any)._messageListeners.get('dumb_binding_key').size).toEqual(2);
    expect((c as any)._messageListeners.get('dumb_binding_key').get(callback2)).toBeTruthy();
  })

  it('should unlisten', async () => {
    const c = await getIdentifiedClient();
    const callback = jest.fn();
    (c as any)._messageListeners.set('dumb_binding_key', new Map([[callback, true]]));
    const unlistenPromise = c.unlisten('dumb_binding_key', callback);
    expect((c as any)._messageListeners.size).toEqual(0);

    // Wait for async hooks to complete
    await new Promise(resolve => setTimeout(resolve, 0));

    expect(mockWs.send).toHaveBeenCalledTimes(2);
    const sentData = mockWs.send.mock.calls.at(-1)[0];
    expect(sentData).toBeInstanceOf(ArrayBuffer);
    const [header, payload] = unbundleData(sentData);
    expect(header).toEqual({
      action: 'unlisten', bindingKey: 'dumb_binding_key', messageId: 'uuid_2'
    });
    const payloadText = new TextDecoder().decode(payload);
    expect(payloadText).toEqual('');
    mockWs.dispatchEvent(new MessageEvent(
      'message',
      { data: bundleData({ action: 'ack', messageId: 'uuid_2' }) },
    ));
    await unlistenPromise;
  });

  it('should not send unlisten message if more than one callbacks', async () => {
    const c = await getIdentifiedClient();
    const [callback1, callback2] = [jest.fn(), jest.fn()];
    (c as any)._messageListeners.set('dumb_binding_key', new Map([
      [callback1, true], [callback2, true]
    ]));
    await c.unlisten('dumb_binding_key', callback2);
    expect((c as any)._messageListeners.get('dumb_binding_key').has(callback1)).toBeTruthy();
    expect((c as any)._messageListeners.get('dumb_binding_key').has(callback2)).toBeFalsy();
    expect(mockWs.send).toHaveBeenCalledTimes(1); // Only the identify message
  });

  it('should receive message', async () => {
    const c = await getIdentifiedClient();
    const callback = jest.fn();
    (c as any)._messageListeners.set('dumb_binding_key', new Map([[callback, true]]));
    mockWs.dispatchEvent(new MessageEvent('message', {
      data: bundleData(
        { action: 'message', routingKey: 'dumb_binding_key' },
        (new TextEncoder()).encode(JSON.stringify({ hello: 'world' })).buffer
      ),
    }));
    expect(callback).toHaveBeenCalledWith({ hello: 'world' });
  });

  it('should disconnect', async () => {
    const c = await getIdentifiedClient();
    const disconnectPromise = c.disconnect();
    expect(mockWs.close).toHaveBeenCalledTimes(1);
    mockWs.dispatchEvent(new Event('close'));
    await disconnectPromise;
  });

  it('should reconnect', async () => {
    const c = await getIdentifiedClient();
    mockWs.dispatchEvent(new Event('reconnecting'));
    expect((c as any)._identified).toBeFalsy();
    mockWs.dispatchEvent(new Event('reconnected'));

    // Wait for async hooks to complete
    await new Promise(resolve => setTimeout(resolve, 0));

    expect(mockWs.send).toHaveBeenCalledTimes(2); // identify message should be resent
    const sentData = mockWs.send.mock.calls.at(-1)[0];
    expect(sentData).toBeInstanceOf(ArrayBuffer);
    const [header, payload] = unbundleData(sentData);
    expect(header).toEqual({
      action: 'identify', sessionId: 'dumb_sessionid', messageId: 'uuid_2'
    });
    const payloadText = new TextDecoder().decode(payload);
    expect(payloadText).toEqual('');
    mockWs.dispatchEvent(new MessageEvent(
      'message',
      { data: bundleData({ action: 'ack', messageId: 'uuid_2' }) },
    ));
    expect((c as any)._identified).toBeTruthy();
  });

  it('should queue messages while reconnecting', async () => {
    const c = await getIdentifiedClient();
    // Start reconnect
    mockWs.dispatchEvent(new Event('reconnecting'));
    // Attempt publish
    const publishPromise = c.publish('dumb_routing_key', { hello: 'world' });
    // Verify message is queued
    expect((c as any)._messageQueue.length).toEqual(1)
    expect((c as any)._messageQueue[0].header).toEqual({
      action: 'publish', messageId: 'uuid_2', routingKey: 'dumb_routing_key'
    });
    let payload = (c as any)._messageQueue[0].payload;
    let payloadText = new TextDecoder().decode(payload);
    expect(JSON.parse(payloadText)).toEqual({ hello: 'world' });
    // Complete reconnect
    mockWs.dispatchEvent(new Event('reconnected'));

    // Wait for async hooks to complete
    await new Promise(resolve => setTimeout(resolve, 0));

    // Verify identify is resent
    expect(mockWs.send).toHaveBeenCalledTimes(2); // identify x2
    let sentData = mockWs.send.mock.calls.at(-1)[0];
    expect(sentData).toBeInstanceOf(ArrayBuffer);
    let header;
    [header, payload] = unbundleData(sentData);
    expect(header).toEqual({
      action: 'identify', sessionId: 'dumb_sessionid', messageId: 'uuid_3'
    });
    payloadText = new TextDecoder().decode(payload);
    expect(payloadText).toEqual('');
    // Ack identify
    mockWs.dispatchEvent(new MessageEvent('message', {
      data: bundleData({ action: 'ack', messageId: 'uuid_3' })
    }));

    // Wait for queued messages to be sent
    await new Promise(resolve => setTimeout(resolve, 0));

    // Verify queued publish is sent
    expect((c as any)._identified).toBeTruthy();
    expect(mockWs.send).toHaveBeenCalledTimes(3); // identifyx2 + publish
    sentData = mockWs.send.mock.calls.at(-1)[0];
    expect(sentData).toBeInstanceOf(ArrayBuffer);
    [header, payload] = unbundleData(sentData);
    expect(header).toEqual({
      action: 'publish', routingKey: 'dumb_routing_key', messageId: 'uuid_2'
    });
    payloadText = new TextDecoder().decode(payload);
    expect(JSON.parse(payloadText)).toEqual({ hello: 'world' });
    // Ack publish
    mockWs.dispatchEvent(new MessageEvent('message', {
      data: bundleData({ action: 'ack', messageId: 'uuid_2' })
    }));
    // Verify publish promise resolves
    await publishPromise;
  });

  it('rejects because of timeout', async () => {
    const c = new WebMQClient({ url: 'dumb_url', sessionId: 'dumb_sessionid', timeoutDelay: 1 });
    const connectPromise = c.connect();
    mockWs.dispatchEvent(new Event('open'));
    mockWs.dispatchEvent(new MessageEvent('message', {
      data: bundleData({ action: 'ack', messageId: 'uuid_1' })
    }));
    await connectPromise;

    const publishPromise = c.publish('dumb_routing_key', { hello: 'world' });

    // Use Jest's rejects matcher to properly handle async rejection
    await expect(publishPromise).rejects.toThrow('Message timeout');
  })

  it('should apply identify hook', async () => {
    const c = new WebMQClient({ url: 'dumb_url', sessionId: 'dumb_sessionid' });

    const onIdentify = async (header: ClientMessageHeader): Promise<ClientMessageHeader> => {
      return { ...header, identify: 'hook' };
    }
    c.addHook('identify', onIdentify);
    expect((c as any)._hooks.identify).toContain(onIdentify);

    c.connect();
    mockWs.dispatchEvent(new Event('open'));

    // Wait for async hooks to complete
    await new Promise(resolve => setTimeout(resolve, 0));

    expect(mockWs.send).toHaveBeenCalledTimes(1);
    const sentData = mockWs.send.mock.calls.at(-1)[0];
    expect(sentData).toBeInstanceOf(ArrayBuffer);
    const [header, payload] = unbundleData(sentData);
    expect(header).toEqual({
      action: 'identify', messageId: 'uuid_1', sessionId: 'dumb_sessionid', identify: 'hook'
    });
    const payloadText = new TextDecoder().decode(payload);
    expect(payloadText).toEqual('');
  });

  it('should apply pre hook to identify', async () => {
    const c = new WebMQClient({ url: 'dumb_url', sessionId: 'dumb_sessionid' });

    const onIdentify = async (header: MessageHeader): Promise<MessageHeader> => {
      return { ...header, pre: 'hook' };
    }
    c.addHook('pre', onIdentify);
    expect((c as any)._hooks.pre).toContain(onIdentify);

    c.connect();
    mockWs.dispatchEvent(new Event('open'));

    // Wait for async hooks to complete
    await new Promise(resolve => setTimeout(resolve, 0));

    expect(mockWs.send).toHaveBeenCalledTimes(1);
    const sentData = mockWs.send.mock.calls.at(-1)[0];
    expect(sentData).toBeInstanceOf(ArrayBuffer);
    const [header, payload] = unbundleData(sentData);
    expect(header).toEqual({
      action: 'identify', messageId: 'uuid_1', sessionId: 'dumb_sessionid', pre: 'hook'
    });
    const payloadText = new TextDecoder().decode(payload);
    expect(payloadText).toEqual('');
  });

  it('should should apply publish hook', async () => {
    const c = await getIdentifiedClient();
    const onPublish = async (header: ClientMessageHeader): Promise<ClientMessageHeader> => {
      return { ...header, publish: 'hook' };
    }
    c.addHook('publish', onPublish);
    expect((c as any)._hooks.publish).toContain(onPublish);

    c.publish('dumb_routing_key', { data: 'dumb_payload' });
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(mockWs.send).toHaveBeenCalledTimes(2);
    const sentData = mockWs.send.mock.calls.at(-1)[0];
    expect(sentData).toBeInstanceOf(ArrayBuffer);
    const [header, payload] = unbundleData(sentData);
    expect(header).toEqual({
      action: 'publish', routingKey: 'dumb_routing_key', messageId: 'uuid_2', publish: 'hook'
    });
    const payloadText = new TextDecoder().decode(payload);
    expect(JSON.parse(payloadText)).toEqual({ data: 'dumb_payload' });
  });

  it('should should apply pre hook to publish', async () => {
    const c = await getIdentifiedClient();
    const onPublish = async (header: MessageHeader): Promise<MessageHeader> => {
      return { ...header, pre: 'hook' };
    }
    c.addHook('pre', onPublish);
    expect((c as any)._hooks.pre).toContain(onPublish);

    c.publish('dumb_routing_key', { data: 'dumb_payload' });
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(mockWs.send).toHaveBeenCalledTimes(2);
    const sentData = mockWs.send.mock.calls.at(-1)[0];
    expect(sentData).toBeInstanceOf(ArrayBuffer);
    const [header, payload] = unbundleData(sentData);
    expect(header).toEqual({
      action: 'publish', routingKey: 'dumb_routing_key', messageId: 'uuid_2', pre: 'hook'
    });
    const payloadText = new TextDecoder().decode(payload);
    expect(JSON.parse(payloadText)).toEqual({ data: 'dumb_payload' });
  });

  it('should remove hook', () => {
    const c = new WebMQClient({ url: 'dumb_url', sessionId: 'dumb_sessionid' });
    const onIdentify = jest.fn();
    c.addHook('identify', onIdentify);
    expect((c as any)._hooks.identify).toContain(onIdentify);
    c.removeHook('identify', onIdentify);
    expect((c as any)._hooks.identify).not.toContain(onIdentify);
  });
});
