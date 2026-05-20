import { describe, it, expect, afterEach } from "vitest";
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
