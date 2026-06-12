/**
 * Invariants for the per-target / non-OAuth2 connect specs in
 * `shared/connectorConfig.ts`. These guard the single source of truth
 * that both the Electron main process (validation + `buildAuthConfig`
 * injection) and the renderer connect modal consume: a spec that names a
 * `tokenField` not present in its own `configFields`, or a token-method
 * provider whose credential field isn't a secret, would silently break
 * connect or leak a credential into the auth_config bag.
 */
import { describe, it, expect } from "vitest";
import {
  CONNECTOR_CONNECT_SPECS,
  authConfigFields,
  getConnectSpec,
} from "../../shared/connectorConfig";
import type { ConnectorConfigField } from "../../shared/connectorConfig";
import { KNOWN_PROVIDERS } from "../ipc/validate";

describe("connectorConfig specs", () => {
  it("only references provider ids that exist in KNOWN_PROVIDERS", () => {
    for (const provider of Object.keys(CONNECTOR_CONNECT_SPECS)) {
      expect(KNOWN_PROVIDERS).toContain(provider);
    }
  });

  it("every spec field has a non-empty key and label", () => {
    for (const spec of Object.values(CONNECTOR_CONNECT_SPECS)) {
      for (const field of spec.configFields) {
        expect(field.key.length).toBeGreaterThan(0);
        expect(field.label.length).toBeGreaterThan(0);
      }
      const keys = spec.configFields.map((f) => f.key);
      expect(new Set(keys).size).toBe(keys.length);
    }
  });

  it("token-method providers name a secret credential field that exists", () => {
    for (const [provider, spec] of Object.entries(CONNECTOR_CONNECT_SPECS)) {
      if (spec.connectMethod !== "token") continue;
      expect(spec.tokenField).toBeDefined();
      const field = spec.configFields.find((f) => f.key === spec.tokenField);
      expect(field, `${provider} tokenField must be a declared field`).toBeDefined();
      // The credential that becomes the bearer token must be a secret
      // (rendered as a password input, stored only in the keychain).
      expect(field?.secret).toBe(true);
      expect(field?.required).toBe(true);
    }
  });

  it("authConfigFields excludes the tokenField but keeps every target field", () => {
    // GitLab: PAT travels as the bearer, project_id/api_base_url stay.
    const gitlab = authConfigFields("gitlab").map((f) => f.key);
    expect(gitlab).not.toContain("personal_access_token");
    expect(gitlab).toContain("project_id");

    // Trello: user token travels as the bearer; key/board_id stay.
    const trello = authConfigFields("trello").map((f) => f.key);
    expect(trello).not.toContain("token");
    expect(trello).toEqual(expect.arrayContaining(["key", "board_id"]));

    // OAuth2 providers keep all their declared fields.
    const asana = authConfigFields("asana").map((f) => f.key);
    expect(asana).toContain("project");
  });

  it("defaults unknown providers to whole-account OAuth2 with no extra fields", () => {
    const spec = getConnectSpec("google_drive");
    expect(spec.connectMethod).toBe("oauth2");
    expect(spec.configFields).toHaveLength(0);
    expect(spec.tokenField).toBeUndefined();
  });

  it("returns the same frozen default spec for every whole-account provider", () => {
    // The default spec is a shared singleton, so it must be immutable —
    // a mutation would otherwise leak across every default provider.
    const a = getConnectSpec("google_drive");
    const b = getConnectSpec("dropbox");
    expect(a).toBe(b);
    expect(Object.isFrozen(a)).toBe(true);
    expect(Object.isFrozen(a.configFields)).toBe(true);
    expect(() => {
      (a.configFields as ConnectorConfigField[]).push({
        key: "x",
        label: "x",
        required: false,
        secret: false,
      });
    }).toThrow();
  });
});
