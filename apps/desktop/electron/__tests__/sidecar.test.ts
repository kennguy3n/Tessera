import {
  describe,
  it,
  expect,
  afterEach,
  beforeEach,
  vi,
  type Mock,
} from "vitest";
import { EventEmitter } from "events";
import { buildSpawnEnv } from "../sidecar";

describe("buildSpawnEnv", () => {
  const originalPlatform = process.platform;

  afterEach(() => {
    Object.defineProperty(process, "platform", { value: originalPlatform });
  });

  function setPlatform(p: NodeJS.Platform) {
    Object.defineProperty(process, "platform", { value: p });
  }

  it("prepends binary dir to LD_LIBRARY_PATH on Linux", () => {
    setPlatform("linux");
    const env = buildSpawnEnv("/opt/tessera/sidecars/llama-server/llama-server", {
      LD_LIBRARY_PATH: "/usr/local/lib",
      HOME: "/home/test",
    });
    expect(env.LD_LIBRARY_PATH).toBe(
      "/opt/tessera/sidecars/llama-server:/usr/local/lib",
    );
    expect(env.HOME).toBe("/home/test");
  });

  it("sets LD_LIBRARY_PATH on Linux when not previously set", () => {
    setPlatform("linux");
    const env = buildSpawnEnv("/opt/llama-server", {});
    expect(env.LD_LIBRARY_PATH).toBe("/opt");
  });

  it("leaves env untouched on macOS", () => {
    setPlatform("darwin");
    const env = buildSpawnEnv("/opt/llama-server", {
      LD_LIBRARY_PATH: "/should/not/change",
      FOO: "bar",
    });
    expect(env.LD_LIBRARY_PATH).toBe("/should/not/change");
    expect(env.FOO).toBe("bar");
  });

  it("leaves env untouched on Windows", () => {
    setPlatform("win32");
    const env = buildSpawnEnv("C:\\tessera\\llama-server.exe", { PATH: "C:\\bin" });
    expect(env.LD_LIBRARY_PATH).toBeUndefined();
    expect(env.PATH).toBe("C:\\bin");
  });
});

/**
 * Lifecycle-orphan regression tests for the detached sidecar.
 *
 * Background: we spawn the llama-server child with `detached: true` on POSIX
 * so we can deliver SIGTERM/SIGKILL to the whole process group. Without two
 * follow-on mitigations (`unref()` + a synchronous `process.on("exit")`
 * fallback) an abnormal main-process shutdown would leave the sidecar as an
 * orphan holding port 8384. These tests pin the mitigations in place so a
 * future refactor cannot silently regress them.
 */
describe("ModelSidecar lifecycle (POSIX detached spawn)", () => {
  const originalPlatform = process.platform;

  // We need to mock child_process.spawn before importing the module so the
  // class picks up our fake spawn. Use dynamic imports inside each test.
  let spawnMock: Mock;
  let fakeChild: EventEmitter & {
    pid: number;
    unref: Mock;
    kill: Mock;
  };

  beforeEach(() => {
    // Drop any sidecar module already cached from the buildSpawnEnv suite
    // above; otherwise our `vi.doMock("child_process", ...)` factory below
    // would never run because the static `import { spawn }` at the top of
    // sidecar.ts was resolved during the previous suite's evaluation.
    vi.resetModules();
    Object.defineProperty(process, "platform", { value: "linux" });
    const emitter = new EventEmitter();
    fakeChild = Object.assign(emitter, {
      pid: 99999,
      unref: vi.fn(),
      kill: vi.fn(),
    });
    spawnMock = vi.fn(() => fakeChild);
    vi.doMock("child_process", async (importOriginal) => {
      const actual = await importOriginal<typeof import("child_process")>();
      return {
        ...actual,
        default: { ...actual, spawn: spawnMock },
        spawn: spawnMock,
      };
    });
  });

  afterEach(() => {
    Object.defineProperty(process, "platform", { value: originalPlatform });
    vi.doUnmock("child_process");
    vi.resetModules();
  });

  it("calls unref() on the detached child so Node's event loop is not pinned by it", async () => {
    const { ModelSidecar } = await import("../sidecar");
    const sidecar = new ModelSidecar({ modelPath: "/tmp/model.gguf" });
    await sidecar.start();
    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(fakeChild.unref).toHaveBeenCalledTimes(1);
    // The third arg to spawn carries the detached flag — verify the contract
    // the unref() guards.
    const spawnOpts = spawnMock.mock.calls[0][2];
    expect(spawnOpts.detached).toBe(true);
  });

  it("registers a synchronous process.on('exit') handler that kills the child process group", async () => {
    const { ModelSidecar } = await import("../sidecar");
    const sidecar = new ModelSidecar({ modelPath: "/tmp/model.gguf" });

    const exitListenersBefore = process.listenerCount("exit");
    await sidecar.start();
    const exitListenersAfter = process.listenerCount("exit");
    expect(exitListenersAfter).toBe(exitListenersBefore + 1);

    // Stub process.kill so we can observe the SIGKILL-to-group call without
    // actually killing the test runner.
    const killSpy = vi
      .spyOn(process, "kill")
      .mockImplementation(() => true as never);
    try {
      // Drive the latest exit listener directly.
      const listeners = process.listeners("exit");
      const ourHandler = listeners[listeners.length - 1] as () => void;
      ourHandler();
      expect(killSpy).toHaveBeenCalledWith(-99999, "SIGKILL");
    } finally {
      killSpy.mockRestore();
    }
    // Clear the lingering listener we just exercised so subsequent tests in
    // this file don't leak `exit` handlers. stop() awaits the child's "exit"
    // event with a 5-second SIGKILL grace window; emit it synthetically so
    // the test doesn't have to wait the full timeout.
    queueMicrotask(() => fakeChild.emit("exit", 0, null));
    await sidecar.stop();
    expect(process.listenerCount("exit")).toBe(exitListenersBefore);
  });

  it("removes the exit handler when stop() runs cleanly so it cannot fire after a normal shutdown", async () => {
    const { ModelSidecar } = await import("../sidecar");
    const sidecar = new ModelSidecar({ modelPath: "/tmp/model.gguf" });

    const exitListenersBefore = process.listenerCount("exit");
    await sidecar.start();
    expect(process.listenerCount("exit")).toBe(exitListenersBefore + 1);

    // Simulate the child exiting on its own (e.g. our SIGTERM in stop()).
    // Schedule the exit emission on the next tick so stop()'s await-promise
    // can attach its own listener first.
    queueMicrotask(() => fakeChild.emit("exit", 0, null));
    await sidecar.stop();

    expect(process.listenerCount("exit")).toBe(exitListenersBefore);
  });

  it("does not register the unref/exit-handler pair on Windows (no detached spawn)", async () => {
    Object.defineProperty(process, "platform", { value: "win32" });
    const { ModelSidecar } = await import("../sidecar");
    const sidecar = new ModelSidecar({ modelPath: "/tmp/model.gguf" });

    const exitListenersBefore = process.listenerCount("exit");
    await sidecar.start();
    expect(fakeChild.unref).not.toHaveBeenCalled();
    expect(process.listenerCount("exit")).toBe(exitListenersBefore);

    queueMicrotask(() => fakeChild.emit("exit", 0, null));
    await sidecar.stop();
  });
});

/**
 * `waitForReady` is the gate IPC handlers (model:start, vision:describe,
 * imagegen:generate) use AFTER `start()` to prevent the well-known
 * "first request lands before llama-server / sd-server has bound its
 * HTTP port" race (Devin Review ANALYSIS_0005). These tests pin its
 * three observable invariants:
 *
 *   1. Returns `true` once `/health` is reachable.
 *   2. Polls again on transient failures rather than giving up.
 *   3. Returns `false` if the deadline elapses without success.
 *
 * The tests mock `globalThis.fetch` so they don't require a real
 * HTTP listener (the spawn mock from the parent describe block
 * already prevents any real sidecar process from starting).
 */
describe("ModelSidecar.waitForReady (HTTP listener readiness gate)", () => {
  const originalPlatform = process.platform;
  const originalFetch = globalThis.fetch;
  let spawnMock: Mock;
  let fakeChild: EventEmitter & {
    pid: number;
    unref: Mock;
    kill: Mock;
  };

  beforeEach(() => {
    vi.resetModules();
    Object.defineProperty(process, "platform", { value: "linux" });
    const emitter = new EventEmitter();
    fakeChild = Object.assign(emitter, {
      pid: 88888,
      unref: vi.fn(),
      kill: vi.fn(),
    });
    spawnMock = vi.fn(() => fakeChild);
    vi.doMock("child_process", async (importOriginal) => {
      const actual = await importOriginal<typeof import("child_process")>();
      return {
        ...actual,
        default: { ...actual, spawn: spawnMock },
        spawn: spawnMock,
      };
    });
  });

  afterEach(() => {
    Object.defineProperty(process, "platform", { value: originalPlatform });
    vi.doUnmock("child_process");
    vi.resetModules();
    globalThis.fetch = originalFetch;
  });

  it("returns true as soon as /health responds 200", async () => {
    const { ModelSidecar } = await import("../sidecar");
    const sidecar = new ModelSidecar({
      modelPath: "/tmp/model.gguf",
      healthCheckIntervalMs: 100,
    });
    await sidecar.start();

    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response("ok", { status: 200 }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const ready = await sidecar.waitForReady(5_000);
    expect(ready).toBe(true);
    expect(fetchMock).toHaveBeenCalled();
    // The very first call asks /health on the sidecar's loopback endpoint.
    const firstUrl = (fetchMock.mock.calls[0] as [string])[0];
    expect(firstUrl).toMatch(/\/health$/);

    queueMicrotask(() => fakeChild.emit("exit", 0, null));
    await sidecar.stop();
  });

  it("keeps polling on transient /health failures until the sidecar reports ready", async () => {
    const { ModelSidecar } = await import("../sidecar");
    const sidecar = new ModelSidecar({
      modelPath: "/tmp/model.gguf",
      healthCheckIntervalMs: 50,
    });
    await sidecar.start();

    let calls = 0;
    const fetchMock = vi.fn().mockImplementation(async () => {
      calls += 1;
      if (calls < 3) throw new Error("ECONNREFUSED");
      return new Response("ok", { status: 200 });
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const ready = await sidecar.waitForReady(10_000);
    expect(ready).toBe(true);
    expect(calls).toBeGreaterThanOrEqual(3);

    queueMicrotask(() => fakeChild.emit("exit", 0, null));
    await sidecar.stop();
  });

  it("returns false when the deadline elapses without /health succeeding", async () => {
    const { ModelSidecar } = await import("../sidecar");
    const sidecar = new ModelSidecar({
      modelPath: "/tmp/model.gguf",
      healthCheckIntervalMs: 30,
    });
    await sidecar.start();

    const fetchMock = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const start = Date.now();
    const ready = await sidecar.waitForReady(200);
    const elapsed = Date.now() - start;
    expect(ready).toBe(false);
    // Bounded by the deadline (200 ms) with a small slack for the
    // final in-flight poll completing.
    expect(elapsed).toBeLessThan(1_500);

    queueMicrotask(() => fakeChild.emit("exit", 0, null));
    await sidecar.stop();
  });

  it("returns false immediately when the sidecar isn't running", async () => {
    const { ModelSidecar } = await import("../sidecar");
    const sidecar = new ModelSidecar({ modelPath: "/tmp/model.gguf" });
    const ready = await sidecar.waitForReady(5_000);
    expect(ready).toBe(false);
  });
});
