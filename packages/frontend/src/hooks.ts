// Generic hook system for middleware execution patterns

export type HookFunction = (
  context: any,
  next: () => Promise<void>,
  ...args: any[]
) => Promise<void>;

export async function runWithHooks(
  context: any,
  hooks: HookFunction[],
  ...args: any[]
): Promise<void> {
  let index = 0;

  async function runNext(): Promise<void> {
    if (index < hooks.length) {
      const hook = hooks[index++];
      await hook(context, runNext, ...args);
    }
  }

  await runNext();
}
