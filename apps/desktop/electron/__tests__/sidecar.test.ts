import {
  describe,
  it,
  expect,
  afterEach,
  beforeEach,
  beforeAll,
  afterAll,
  vi,
  type Mock,
} from "vitest";
import { EventEmitter } from "events";
import { buildSpawnEnv } from "../sidecar";

// File-scope defense-in-depth: assert that no test in this file mutates
// `process.platform`. The prior incarnation of this suite used
// `Object.defineProperty(process, "platform", ...)` + an `afterEach`
// restore — a sequential-only pattern that becomes a parallel-safety
// footgun under `vitest --pool=threads` with shared worker pools (a
// concurrent test in another describe block could observe the mutated
// global). The current suite injects `platform` either as a direct
// argument to `buildSpawnEnv()` or as a `SidecarOptions.platform`
// field on `new ModelSidecar(...)`. These hooks snapshot the live
// `process.platform` at file load and assert it's unchanged at
// teardown so any future test that reintroduces global mutation
// fails loudly here rather than silently corrupting a neighbour.
// Mirrors the architectural pattern landed in PR #57 for
// `extensionSocketPath.test.ts`.
const ORIGINAL_PLATFORM = process.platform;
beforeAll(() => {
  expect(process.platform).toBe(ORIGINAL_PLATFORM);
});
afterAll(() => {
  expect(process.platform).toBe(ORIGINAL_PLATFORM);
});

describe("buildSpawnEnv", () => {
  it("prepends binary dir to LD_LIBRARY_PATH on Linux", () => {
    const env = buildSpawnEnv(
      "/opt/tessera/sidecars/llama-server/llama-server",
      { LD_LIBRARY_PATH: "/usr/local/lib", HOME: "/home/test" },
      "linux",
    );
    expect(env.LD_LIBRARY_PATH).toBe(
      "/opt/tessera/sidecars/llama-server:/usr/local/lib",
    );
    expect(env.HOME).toBe("/home/test");
  });

  it("sets LD_LIBRARY_PATH on Linux when not previously set", () => {
    const env = buildSpawnEnv("/opt/llama-server", {}, "linux");
    expect(env.LD_LIBRARY_PATH).toBe("/opt");
  });

  it("leaves env untouched on macOS", () => {
    const env = buildSpawnEnv(
      "/opt/llama-server",
      { LD_LIBRARY_PATH: "/should/not/change", FOO: "bar" },
      "darwin",
    );
    expect(env.LD_LIBRARY_PATH).toBe("/should/not/change");
    expect(env.FOO).toBe("bar");
  });

  it("leaves env untouched on Windows", () => {
    const env = buildSpawnEnv(
      "C:\\tessera\\llama-server.exe",
      { PATH: "C:\\bin" },
      "win32",
    );
    expect(env.LD_LIBRARY_PATH).toBeUndefined();
    expect(env.PATH).toBe("C:\\bin");
  });

  // Regression: the no-arg-platform path must equal calling the
  // function with the live `process.platform` value. Production
  // callers (`ModelSidecar.start()` via `this.options.platform`,
  // which defaults to `process.platform` at construction) rely on
  // this default behavior. If a future refactor accidentally
  // hard-coded `"linux"` as the default this test would catch it
  // on every non-Linux runner.
  it("no-platform call matches the explicit-platform call for the live platform", () => {
    const env1 = buildSpawnEnv("/opt/llama-server", { HOME: "/x" });
    const env2 = buildSpawnEnv(
      "/opt/llama-server",
      { HOME: "/x" },
      process.platform,
    );
    expect(env1).toEqual(env2);
  });

  // Parallel-safety meta-test: prove that calling buildSpawnEnv
  // with various injected platforms does NOT mutate
  // `process.platform`. The prior implementation of this suite
  // mutated the global via `Object.defineProperty` and restored
  // it in `afterEach` — a sequential-only pattern. This test
  // pins the architectural guarantee that the current
  // implementation is purely a pure function of its arguments.
  it("does not mutate process.platform when called with various platforms", () => {
    const before = process.platform;
    for (const platform of ["linux", "darwin", "win32", "freebsd"] as const) {
      buildSpawnEnv("/opt/llama-server", {}, platform);
    }
    expect(process.platform).toBe(before);
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
 *
 * The platform under test is passed via the `SidecarOptions.platform`
 * field rather than by mutating `process.platform` — see the
 * file-scope `beforeAll`/`afterAll` for rationale.
 */
describe("ModelSidecar lifecycle (POSIX detached spawn)", () => {
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
    vi.doUnmock("child_process");
    vi.resetModules();
  });

  it("calls unref() on the detached child so Node's event loop is not pinned by it", async () => {
    const { ModelSidecar } = await import("../sidecar");
    const sidecar = new ModelSidecar({
      modelPath: "/tmp/model.gguf",
      platform: "linux",
    });
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
    const sidecar = new ModelSidecar({
      modelPath: "/tmp/model.gguf",
      platform: "linux",
    });

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
    const sidecar = new ModelSidecar({
      modelPath: "/tmp/model.gguf",
      platform: "linux",
    });

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

  it("removes the exit handler when the child errors so a failed spawn doesn't leak a listener slot per restart attempt", async () => {
    // Regression test for Devin Review follow-up
    // (ANALYSIS_pr-review-job-095e635be43f4af68e37c59e0af14838_0002).
    // The `error` handler was previously asymmetric with the
    // `exit` handler: it dropped `_isRunning` and stopped the
    // monitors, but left the `process.on("exit")` SIGKILL-fallback
    // listener registered. A misconfigured binary path that keeps
    // hitting ENOENT would slowly accumulate listeners and trip
    // Node's MaxListenersExceededWarning (default 10). Stops at 1
    // here because we only spawn once, but the assertion guards
    // the cleanup contract.
    const { ModelSidecar } = await import("../sidecar");
    const sidecar = new ModelSidecar({
      modelPath: "/tmp/model.gguf",
      platform: "linux",
    });

    const exitListenersBefore = process.listenerCount("exit");
    await sidecar.start();
    expect(process.listenerCount("exit")).toBe(exitListenersBefore + 1);

    // Simulate child-process emitter firing the `error` event
    // (e.g. ENOENT, spawn EPERM). The handler must drop its
    // process.on("exit") listener so we end up back at the
    // baseline count.
    fakeChild.emit("error", new Error("ENOENT"));
    expect(process.listenerCount("exit")).toBe(exitListenersBefore);
  });

  it("does not register the unref/exit-handler pair on Windows (no detached spawn)", async () => {
    const { ModelSidecar } = await import("../sidecar");
    const sidecar = new ModelSidecar({
      modelPath: "/tmp/model.gguf",
      platform: "win32",
    });

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
 *
 * Platform is passed via `SidecarOptions.platform` rather than
 * by mutating `process.platform`.
 */
describe("ModelSidecar.waitForReady (HTTP listener readiness gate)", () => {
  const originalFetch = globalThis.fetch;
  let spawnMock: Mock;
  let fakeChild: EventEmitter & {
    pid: number;
    unref: Mock;
    kill: Mock;
  };

  beforeEach(() => {
    vi.resetModules();
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
    vi.doUnmock("child_process");
    vi.resetModules();
    globalThis.fetch = originalFetch;
  });

  it("returns true as soon as /health responds 200", async () => {
    const { ModelSidecar } = await import("../sidecar");
    const sidecar = new ModelSidecar({
      modelPath: "/tmp/model.gguf",
      healthCheckIntervalMs: 100,
      platform: "linux",
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
      platform: "linux",
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
      platform: "linux",
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
    const sidecar = new ModelSidecar({
      modelPath: "/tmp/model.gguf",
      platform: "linux",
    });
    const ready = await sidecar.waitForReady(5_000);
    expect(ready).toBe(false);
  });
});
