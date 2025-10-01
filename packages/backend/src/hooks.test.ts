import { HookFunction, runWithHooks } from './hooks';

describe('Hook System', () => {
  describe('runWithHooks', () => {
    it('should execute function when no hooks provided', async () => {
      const mockFunc = jest.fn().mockResolvedValue(undefined);
      const context = {};
      const data = { test: 'data' };

      await runWithHooks(context, [], data, mockFunc);

      expect(mockFunc).toHaveBeenCalledTimes(1);
    });

    it('should execute hooks in order before function', async () => {
      const executionOrder: string[] = [];
      const mockFunc = jest.fn(async () => {
        executionOrder.push('function');
      });

      const hook1: HookFunction = async (context, data, next) => {
        executionOrder.push('hook1');
        await next();
      };

      const hook2: HookFunction = async (context, data, next) => {
        executionOrder.push('hook2');
        await next();
      };

      await runWithHooks({}, [hook1, hook2], {}, mockFunc);

      expect(executionOrder).toEqual(['hook1', 'hook2', 'function']);
      expect(mockFunc).toHaveBeenCalledTimes(1);
    });

    it('should pass context and data to each hook', async () => {
      const context = { userId: 'test-user' };
      const data = { action: 'test' };
      const hookCalls: Array<{ context: any; data: any }> = [];

      const hook1: HookFunction = async (ctx, dt, next) => {
        hookCalls.push({ context: ctx, data: dt });
        await next();
      };

      const hook2: HookFunction = async (ctx, dt, next) => {
        hookCalls.push({ context: ctx, data: dt });
        await next();
      };

      await runWithHooks(context, [hook1, hook2], data, jest.fn().mockResolvedValue(undefined));

      expect(hookCalls).toHaveLength(2);
      expect(hookCalls[0]).toEqual({ context, data });
      expect(hookCalls[1]).toEqual({ context, data });
    });

    it('should allow hooks to modify context', async () => {
      const context = { counter: 0 };

      const hook1: HookFunction = async (ctx, data, next) => {
        ctx.counter += 1;
        await next();
      };

      const hook2: HookFunction = async (ctx, data, next) => {
        ctx.counter += 10;
        await next();
      };

      const mockFunc = jest.fn().mockResolvedValue(undefined);
      await runWithHooks(context, [hook1, hook2], {}, mockFunc);

      expect(context.counter).toBe(11);
      expect(mockFunc).toHaveBeenCalledTimes(1);
    });

    it('should stop execution if hook does not call next', async () => {
      const executionOrder: string[] = [];
      const mockFunc = jest.fn(async () => {
        executionOrder.push('function');
      });

      const hook1: HookFunction = async (context, data, next) => {
        executionOrder.push('hook1');
        // Intentionally not calling next()
      };

      const hook2: HookFunction = async (context, data, next) => {
        executionOrder.push('hook2');
        await next();
      };

      await runWithHooks({}, [hook1, hook2], {}, mockFunc);

      expect(executionOrder).toEqual(['hook1']);
      expect(mockFunc).not.toHaveBeenCalled();
    });

    it('should propagate errors from hooks', async () => {
      const hook1: HookFunction = async (context, data, next) => {
        await next();
      };

      const hook2: HookFunction = async (context, data, next) => {
        throw new Error('Hook error');
      };

      await expect(
        runWithHooks({}, [hook1, hook2], {}, jest.fn().mockResolvedValue(undefined))
      ).rejects.toThrow('Hook error');
    });

    it('should propagate errors from the main function', async () => {
      const hook: HookFunction = async (context, data, next) => {
        await next();
      };

      const mockFunc = jest.fn(async () => {
        throw new Error('Function error');
      });

      await expect(
        runWithHooks({}, [hook], {}, mockFunc)
      ).rejects.toThrow('Function error');
    });

    it('should handle async hooks properly', async () => {
      const executionOrder: string[] = [];

      const hook1: HookFunction = async (context, data, next) => {
        executionOrder.push('hook1-start');
        await new Promise(resolve => setTimeout(resolve, 10));
        executionOrder.push('hook1-end');
        await next();
      };

      const hook2: HookFunction = async (context, data, next) => {
        executionOrder.push('hook2');
        await next();
      };

      const mockFunc = jest.fn(async () => {
        executionOrder.push('function');
      });

      await runWithHooks({}, [hook1, hook2], {}, mockFunc);

      expect(executionOrder).toEqual(['hook1-start', 'hook1-end', 'hook2', 'function']);
    });

    it('should work with typed data', async () => {
      interface TestData {
        action: string;
        value: number;
      }

      const data: TestData = { action: 'test', value: 42 };
      const receivedData: TestData[] = [];

      const hook: HookFunction<TestData> = async (context, dt, next) => {
        receivedData.push(dt);
        await next();
      };

      await runWithHooks({}, [hook], data, jest.fn().mockResolvedValue(undefined));

      expect(receivedData).toEqual([data]);
    });
  });
});