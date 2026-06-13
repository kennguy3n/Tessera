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
  connectorTokenType,
  getConnectSpec,
  validateConnectorField,
} from "../../shared/connectorConfig";
import type { ConnectorConfigField } from "../../shared/connectorConfig";
import { KNOWN_PROVIDERS } from "../ipc/validate";

/** Resolve a declared field by `key` for the inline-validation tests. */
function field(provider: string, key: string): ConnectorConfigField {
  const f = getConnectSpec(provider).configFields.find((c) => c.key === key);
  if (!f) throw new Error(`${provider}.${key} not declared`);
  return f;
}

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

  it("every declared validation rule has a non-empty message", () => {
    for (const spec of Object.values(CONNECTOR_CONNECT_SPECS)) {
      for (const f of spec.configFields) {
        if (f.validation) expect(f.validation.message.length).toBeGreaterThan(0);
      }
    }
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

describe("validateConnectorField", () => {
  it("treats an empty required field as invalid and an empty optional field as valid", () => {
    expect(validateConnectorField(field("gitlab", "project_id"), "  ")).toEqual({
      valid: false,
      error: "Project ID or path is required.",
    });
    expect(validateConnectorField(field("gitlab", "api_base_url"), "")).toEqual({
      valid: true,
    });
  });

  it("trims before validating", () => {
    // Surrounding whitespace must not defeat the format rule nor the
    // required check — the host trims before persisting.
    expect(
      validateConnectorField(field("asana", "project"), "  1201234567890123  ")
        .valid,
    ).toBe(true);
  });

  it("enforces the GitLab PAT prefix + length", () => {
    expect(validateConnectorField(field("gitlab", "personal_access_token"), "glpat-secret").valid).toBe(false);
    expect(
      validateConnectorField(
        field("gitlab", "personal_access_token"),
        "glpat-abcdefghij0123456789",
      ).valid,
    ).toBe(true);
  });

  it("accepts a numeric id or a namespace path for the GitLab project", () => {
    expect(validateConnectorField(field("gitlab", "project_id"), "42").valid).toBe(true);
    expect(
      validateConnectorField(field("gitlab", "project_id"), "group/sub/project").valid,
    ).toBe(true);
    expect(
      validateConnectorField(field("gitlab", "project_id"), "bad space").valid,
    ).toBe(false);
  });

  it("requires a full https:// URL for an optional base URL", () => {
    const f = field("gitlab", "api_base_url");
    expect(validateConnectorField(f, "https://gitlab.example.com").valid).toBe(true);
    expect(validateConnectorField(f, "http://gitlab.example.com").valid).toBe(false);
    expect(validateConnectorField(f, "gitlab.example.com").valid).toBe(false);
  });

  it("enforces Trello key/token/board id shapes", () => {
    expect(validateConnectorField(field("trello", "key"), "a".repeat(32)).valid).toBe(true);
    expect(validateConnectorField(field("trello", "key"), "a".repeat(10)).valid).toBe(false);
    expect(validateConnectorField(field("trello", "token"), "b".repeat(64)).valid).toBe(true);
    expect(validateConnectorField(field("trello", "token"), "b".repeat(10)).valid).toBe(false);
    // 8-char short link OR 24-char hex id.
    expect(validateConnectorField(field("trello", "board_id"), "abcd1234").valid).toBe(true);
    expect(validateConnectorField(field("trello", "board_id"), "0".repeat(24)).valid).toBe(true);
  });

  it("rejects a non-GUID Teams id and accepts a GUID", () => {
    expect(
      validateConnectorField(
        field("teams", "team_id"),
        "a1b2c3d4-5e6f-7a8b-9c0d-1e2f3a4b5c6d",
      ).valid,
    ).toBe(true);
    expect(validateConnectorField(field("teams", "team_id"), "not-a-guid").valid).toBe(false);
  });

  // ── Tranche 4: per-target / per-resource providers ─────────────────

  it("validates the Discord bot token + channel snowflake", () => {
    // Bot token: charset + conservative min length (50).
    expect(validateConnectorField(field("discord", "bot_token"), "a".repeat(60)).valid).toBe(true);
    expect(validateConnectorField(field("discord", "bot_token"), "a".repeat(20)).valid).toBe(false);
    expect(
      validateConnectorField(field("discord", "bot_token"), `has space ${"a".repeat(60)}`).valid,
    ).toBe(false);
    // Channel ID: 17-20 digit snowflake.
    expect(validateConnectorField(field("discord", "channel_id"), "1107583106847408128").valid).toBe(true);
    expect(validateConnectorField(field("discord", "channel_id"), "123").valid).toBe(false);
    expect(validateConnectorField(field("discord", "channel_id"), "12345678901234567890123").valid).toBe(false);
  });

  it("validates the Bitbucket workspace + repo slugs", () => {
    expect(validateConnectorField(field("bitbucket", "workspace"), "my-workspace").valid).toBe(true);
    expect(validateConnectorField(field("bitbucket", "workspace"), "-leading").valid).toBe(false);
    expect(validateConnectorField(field("bitbucket", "repo_slug"), "my.repo-1").valid).toBe(true);
    expect(validateConnectorField(field("bitbucket", "repo_slug"), "bad slug").valid).toBe(false);
  });

  it("validates the Airtable base id + PAT shape", () => {
    expect(validateConnectorField(field("airtable", "base_id"), "app1234567890ABCD").valid).toBe(true);
    expect(validateConnectorField(field("airtable", "base_id"), "tbl1234567890ABCD").valid).toBe(false);
    expect(
      validateConnectorField(
        field("airtable", "personal_access_token"),
        `pat1234567890ABCD.${"a".repeat(50)}`,
      ).valid,
    ).toBe(true);
    expect(
      validateConnectorField(field("airtable", "personal_access_token"), "not-a-pat").valid,
    ).toBe(false);
    // A free-text table name is accepted (id or human label).
    expect(validateConnectorField(field("airtable", "table"), "Tasks").valid).toBe(true);
  });

  it("validates the Monday numeric board id", () => {
    expect(validateConnectorField(field("monday", "board_id"), "1234567890").valid).toBe(true);
    expect(validateConnectorField(field("monday", "board_id"), "not-a-number").valid).toBe(false);
  });

  // ── Tranche 5: read-only support / CRM providers ───────────────────

  it("validates the ClickUp numeric workspace id + optional API base URL", () => {
    expect(validateConnectorField(field("clickup", "team_id"), "9001234567").valid).toBe(true);
    expect(validateConnectorField(field("clickup", "team_id"), "not-a-number").valid).toBe(false);
    // Required: an empty value is rejected before any IPC round-trip.
    expect(validateConnectorField(field("clickup", "team_id"), "  ").valid).toBe(false);
    const base = field("clickup", "api_base_url");
    expect(validateConnectorField(base, "").valid).toBe(true);
    expect(validateConnectorField(base, "https://api.clickup.com").valid).toBe(true);
    expect(validateConnectorField(base, "http://api.clickup.com").valid).toBe(false);
  });

  it("validates Intercom's optional regional API base URL", () => {
    const base = field("intercom", "api_base_url");
    expect(validateConnectorField(base, "").valid).toBe(true);
    expect(validateConnectorField(base, "https://api.eu.intercom.io").valid).toBe(true);
    expect(validateConnectorField(base, "ftp://api.intercom.io").valid).toBe(false);
  });

  it("requires a full https:// My Domain URL for Salesforce", () => {
    const base = field("salesforce", "api_base_url");
    expect(base.required).toBe(true);
    expect(validateConnectorField(base, "https://acme.my.salesforce.com").valid).toBe(true);
    expect(validateConnectorField(base, "acme.my.salesforce.com").valid).toBe(false);
    // Required: a blank instance URL is rejected inline.
    expect(validateConnectorField(base, "   ").valid).toBe(false);
  });

  it("keeps the tranche-5 providers on the OAuth2 browser grant with per-target fields", () => {
    for (const provider of ["clickup", "intercom", "salesforce"] as const) {
      expect(getConnectSpec(provider).connectMethod).toBe("oauth2");
      // OAuth2 specs carry no tokenField (the browser grant supplies it).
      expect(getConnectSpec(provider).tokenField).toBeUndefined();
    }
    // The per-target ids survive into the auth_config bag.
    expect(authConfigFields("clickup").map((f) => f.key)).toContain("team_id");
    expect(authConfigFields("salesforce").map((f) => f.key)).toContain("api_base_url");
  });

  it("threads the Discord `Bot` auth scheme and defaults everything else to Bearer", () => {
    // Discord bot tokens must be sent as `Authorization: Bot <token>`.
    expect(connectorTokenType("discord")).toBe("Bot");
    // Every other provider — OAuth2 or token — uses the Bearer default.
    for (const provider of KNOWN_PROVIDERS) {
      if (provider === "discord") continue;
      expect(connectorTokenType(provider)).toBe("Bearer");
    }
  });

  it("keeps Monday on the OAuth2 browser grant while Discord/Bitbucket/Airtable use a pasted token", () => {
    expect(getConnectSpec("monday").connectMethod).toBe("oauth2");
    expect(getConnectSpec("discord").connectMethod).toBe("token");
    expect(getConnectSpec("bitbucket").connectMethod).toBe("token");
    expect(getConnectSpec("airtable").connectMethod).toBe("token");
    // The per-target id fields survive into the auth_config bag.
    expect(authConfigFields("discord").map((f) => f.key)).toContain("channel_id");
    expect(authConfigFields("bitbucket").map((f) => f.key)).toEqual(
      expect.arrayContaining(["workspace", "repo_slug"]),
    );
    expect(authConfigFields("airtable").map((f) => f.key)).toEqual(
      expect.arrayContaining(["base_id", "table"]),
    );
    expect(authConfigFields("monday").map((f) => f.key)).toContain("board_id");
  });
});
