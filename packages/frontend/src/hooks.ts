// Generic hook system for middleware execution patterns

export type HookFunction<TData = any> = (
  context: any,
  data: TData,
  next: () => Promise<void>
) => Promise<void>;

export async function runWithHooks<TData = any>(
  context: any,
  hooks: HookFunction<TData>[],
  data: TData,
  func: () => Promise<void>
): Promise<void> {
  let index = 0;

  async function runNext(): Promise<void> {
    if (index < hooks.length) {
      const hook = hooks[index++];
      await hook(context, data, runNext);
    } else {
      await func();
    }
  }

  await runNext();
}
