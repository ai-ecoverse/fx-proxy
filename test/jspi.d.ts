// JSPI (WebAssembly.Suspending / .promising) is not yet in lib.dom; the
// worker and its test harness rely on it. These are the shapes we use.
declare namespace WebAssembly {
  class Suspending<T extends (...args: any[]) => any> {
    constructor(fn: T);
  }
  function promising<T extends (...args: any[]) => any>(fn: T): (...args: Parameters<T>) => Promise<ReturnType<T>>;
}
