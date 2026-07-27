export async function retry<T>(
  fn: () => Promise<T>,
  delays = [0, 100, 200, 400]
) {
  let error;
  for (let delay of delays) {
    await new Promise((resolve) => setTimeout(resolve, delay));
    try {
      return await fn();
    } catch (err) {
      error = err;
    }
  }
  throw error;
}
