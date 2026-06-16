/**
 * Built-in Base starter templates.
 *
 * A {@link BaseTemplate} is a stateless metadata starter (mirroring
 * `slideTemplates.ts`): an id + gallery copy + a `build()` that mints a
 * fresh {@link BaseDocument} on demand. Inserting a template REPLACES
 * the editor's document, so every `build()` returns a self-contained
 * base — tables, fields, a handful of sample records, and a starter
 * "app usage" config (a dashboard + an intake form) that references the
 * just-minted table ids. That makes the flagship app-mode feature
 * immediately demonstrable from any inserted template without forcing
 * it open (`defaultMode` is intentionally left unset, so a template
 * still opens in builder mode).
 *
 * `build()` mints new table/record ids on each call (via the shared
 * generators) so two inserts never share ids, and the embedded app
 * config wires its form/widget references to those same table ids.
 * Records carry explicit ids here; the apply path still re-normalises
 * through `parseBaseDocument`, so a template is held to the exact same
 * validation as any loaded base.
 */

import { makeRecordId } from "./baseEditorHelpers";
import { makeTableId } from "./baseDocumentHelpers";
import { makeAppId } from "./baseviews/appmode/appConfig";
import type {
  BaseAppConfig,
  BaseDocument,
  BaseField,
  BaseRecord,
  BaseTable,
} from "./baseEditorTypes";

/** Gallery groupings for the built-in starters. */
export const BASE_TEMPLATE_CATEGORIES = [
  "Sales",
  "Projects",
  "Content",
  "HR",
  "Operations",
] as const;

export type BaseTemplateCategory = (typeof BASE_TEMPLATE_CATEGORIES)[number];

/**
 * A built-in starter base. `build()` is a factory (not a cached value)
 * so each insert gets fresh ids and an independent record set.
 */
export interface BaseTemplate {
  /** Stable built-in id (kebab-case), e.g. `"crm"`. Never reused. */
  id: string;
  label: string;
  description: string;
  category: BaseTemplateCategory;
  build: () => BaseDocument;
}

// ─────────────────────────────────────────────────────────────────────
// Tiny builder helpers (keep each template declaration readable)
// ─────────────────────────────────────────────────────────────────────

/** A record with a freshly-minted id plus the given field values. */
function rec(values: Record<string, unknown>): BaseRecord {
  return { id: makeRecordId(), ...values };
}

function table(
  name: string,
  fields: BaseField[],
  rows: BaseRecord[],
): BaseTable {
  return { id: makeTableId(), name, fields, records: rows };
}

/** Assemble a single-table document with an app config wired to its id. */
function singleTableApp(
  t: BaseTable,
  app: (tableId: string) => BaseAppConfig,
): BaseDocument {
  return { tables: [t], activeTableId: t.id, app: app(t.id) };
}

const select = (name: string, options: string[]): BaseField => ({
  name,
  type: "select",
  options,
});

// ─────────────────────────────────────────────────────────────────────
// Templates
// ─────────────────────────────────────────────────────────────────────

function buildCrm(): BaseDocument {
  const t = table(
    "Contacts",
    [
      { name: "Name", type: "text" },
      { name: "Company", type: "text" },
      { name: "Email", type: "email" },
      select("Stage", ["Lead", "Qualified", "Proposal", "Won", "Lost"]),
      { name: "Deal value", type: "currency" },
      { name: "Owner", type: "user" },
      { name: "Last contact", type: "date" },
      { name: "Notes", type: "long_text" },
    ],
    [
      rec({
        Name: "Ada Lovelace",
        Company: "Analytical Engines",
        Email: "ada@analytical.example",
        Stage: "Proposal",
        "Deal value": 24000,
        Owner: "Sam",
        "Last contact": "2026-05-28",
        Notes: "Sent revised pricing.",
      }),
      rec({
        Name: "Grace Hopper",
        Company: "Compiler Co",
        Email: "grace@compiler.example",
        Stage: "Won",
        "Deal value": 51000,
        Owner: "Sam",
        "Last contact": "2026-06-02",
      }),
      rec({
        Name: "Alan Turing",
        Company: "Bombe Ltd",
        Email: "alan@bombe.example",
        Stage: "Qualified",
        "Deal value": 12000,
        Owner: "Riley",
        "Last contact": "2026-06-09",
      }),
      rec({
        Name: "Katherine Johnson",
        Company: "Orbital",
        Email: "kj@orbital.example",
        Stage: "Lead",
        "Deal value": 8000,
        Owner: "Riley",
      }),
    ],
  );
  return singleTableApp(t, (tableId) => ({
    name: "CRM",
    forms: [
      {
        id: makeAppId(),
        name: "Add contact",
        tableId,
        fieldNames: [
          "Name",
          "Company",
          "Email",
          "Stage",
          "Deal value",
          "Owner",
        ],
        description:
          "Capture a new contact and where they sit in the pipeline.",
      },
    ],
    dashboard: {
      title: "Pipeline",
      widgets: [
        { id: makeAppId(), kind: "count", tableId, title: "Contacts" },
        {
          id: makeAppId(),
          kind: "rollup",
          tableId,
          title: "Open + won value",
          valueField: "Deal value",
          aggregation: "SUM",
        },
        {
          id: makeAppId(),
          kind: "chart",
          tableId,
          title: "Value by stage",
          groupByField: "Stage",
          valueField: "Deal value",
          aggregation: "SUM",
        },
        {
          id: makeAppId(),
          kind: "group",
          tableId,
          title: "Contacts by stage",
          groupByField: "Stage",
        },
      ],
    },
  }));
}

function buildProjectTracker(): BaseDocument {
  const t = table(
    "Tasks",
    [
      { name: "Title", type: "text" },
      select("Status", ["Todo", "In progress", "Blocked", "Done"]),
      select("Priority", ["Low", "Medium", "High"]),
      { name: "Assignee", type: "user" },
      { name: "Due date", type: "date" },
      { name: "Estimate", type: "duration" },
      { name: "Done", type: "checkbox" },
    ],
    [
      rec({
        Title: "Draft project brief",
        Status: "Done",
        Priority: "High",
        Assignee: "Jordan",
        "Due date": "2026-05-30",
        Estimate: 120,
        Done: true,
      }),
      rec({
        Title: "Wireframe dashboard",
        Status: "In progress",
        Priority: "High",
        Assignee: "Lee",
        "Due date": "2026-06-18",
        Estimate: 240,
        Done: false,
      }),
      rec({
        Title: "Set up CI pipeline",
        Status: "Blocked",
        Priority: "Medium",
        Assignee: "Lee",
        "Due date": "2026-06-20",
        Estimate: 180,
        Done: false,
      }),
      rec({
        Title: "Write release notes",
        Status: "Todo",
        Priority: "Low",
        Assignee: "Jordan",
        "Due date": "2026-06-25",
        Estimate: 60,
        Done: false,
      }),
    ],
  );
  return singleTableApp(t, (tableId) => ({
    name: "Project tracker",
    forms: [
      {
        id: makeAppId(),
        name: "New task",
        tableId,
        fieldNames: [
          "Title",
          "Status",
          "Priority",
          "Assignee",
          "Due date",
          "Estimate",
        ],
      },
    ],
    dashboard: {
      title: "Project status",
      widgets: [
        { id: makeAppId(), kind: "count", tableId, title: "Total tasks" },
        {
          id: makeAppId(),
          kind: "group",
          tableId,
          title: "By status",
          groupByField: "Status",
        },
        {
          id: makeAppId(),
          kind: "chart",
          tableId,
          title: "Tasks by priority",
          groupByField: "Priority",
          aggregation: "COUNT",
        },
      ],
    },
  }));
}

function buildContentCalendar(): BaseDocument {
  const t = table(
    "Content",
    [
      { name: "Title", type: "text" },
      select("Channel", ["Blog", "Newsletter", "Social", "Video"]),
      select("Status", ["Idea", "Draft", "Scheduled", "Published"]),
      { name: "Publish date", type: "date" },
      { name: "Author", type: "user" },
      { name: "Link", type: "url" },
    ],
    [
      rec({
        Title: "Local-first, explained",
        Channel: "Blog",
        Status: "Published",
        "Publish date": "2026-05-20",
        Author: "Mara",
        Link: "https://example.com/local-first",
      }),
      rec({
        Title: "June product update",
        Channel: "Newsletter",
        Status: "Scheduled",
        "Publish date": "2026-06-30",
        Author: "Mara",
      }),
      rec({
        Title: "Behind the app-mode demo",
        Channel: "Video",
        Status: "Draft",
        "Publish date": "2026-07-08",
        Author: "Nico",
      }),
      rec({
        Title: "Templates teaser",
        Channel: "Social",
        Status: "Idea",
        Author: "Nico",
      }),
    ],
  );
  return singleTableApp(t, (tableId) => ({
    name: "Content calendar",
    forms: [
      {
        id: makeAppId(),
        name: "Pitch content",
        tableId,
        fieldNames: ["Title", "Channel", "Status", "Publish date", "Author"],
      },
    ],
    dashboard: {
      title: "Editorial overview",
      widgets: [
        { id: makeAppId(), kind: "count", tableId, title: "Pieces planned" },
        {
          id: makeAppId(),
          kind: "group",
          tableId,
          title: "By status",
          groupByField: "Status",
        },
        {
          id: makeAppId(),
          kind: "chart",
          tableId,
          title: "By channel",
          groupByField: "Channel",
          aggregation: "COUNT",
        },
      ],
    },
  }));
}

function buildApplicantTracker(): BaseDocument {
  const t = table(
    "Applicants",
    [
      { name: "Name", type: "text" },
      { name: "Role", type: "text" },
      select("Stage", [
        "Applied",
        "Screen",
        "Interview",
        "Offer",
        "Hired",
        "Rejected",
      ]),
      { name: "Email", type: "email" },
      { name: "Rating", type: "rating" },
      { name: "Applied on", type: "date" },
    ],
    [
      rec({
        Name: "Priya Patel",
        Role: "Frontend engineer",
        Stage: "Interview",
        Email: "priya@example.com",
        Rating: 4,
        "Applied on": "2026-06-01",
      }),
      rec({
        Name: "Diego Ramirez",
        Role: "Frontend engineer",
        Stage: "Screen",
        Email: "diego@example.com",
        Rating: 3,
        "Applied on": "2026-06-05",
      }),
      rec({
        Name: "Mei Chen",
        Role: "Designer",
        Stage: "Offer",
        Email: "mei@example.com",
        Rating: 5,
        "Applied on": "2026-05-22",
      }),
      rec({
        Name: "Tom Becker",
        Role: "Designer",
        Stage: "Applied",
        Email: "tom@example.com",
        "Applied on": "2026-06-11",
      }),
    ],
  );
  return singleTableApp(t, (tableId) => ({
    name: "Applicant tracker",
    forms: [
      {
        id: makeAppId(),
        name: "New applicant",
        tableId,
        fieldNames: ["Name", "Role", "Stage", "Email", "Rating", "Applied on"],
      },
    ],
    dashboard: {
      title: "Hiring funnel",
      widgets: [
        { id: makeAppId(), kind: "count", tableId, title: "Applicants" },
        {
          id: makeAppId(),
          kind: "chart",
          tableId,
          title: "By stage",
          groupByField: "Stage",
          aggregation: "COUNT",
        },
        {
          id: makeAppId(),
          kind: "rollup",
          tableId,
          title: "Average rating",
          valueField: "Rating",
          aggregation: "AVG",
        },
      ],
    },
  }));
}

function buildAssetInventory(): BaseDocument {
  const t = table(
    "Assets",
    [
      { name: "Name", type: "text" },
      select("Category", ["Laptop", "Monitor", "Phone", "Furniture", "Other"]),
      select("Status", ["In use", "In storage", "Repair", "Retired"]),
      { name: "Serial", type: "text" },
      { name: "Value", type: "currency" },
      { name: "Assigned to", type: "user" },
      { name: "Purchased", type: "date" },
    ],
    [
      rec({
        Name: "MacBook Pro 14",
        Category: "Laptop",
        Status: "In use",
        Serial: "C02-001",
        Value: 2200,
        "Assigned to": "Sam",
        Purchased: "2025-09-12",
      }),
      rec({
        Name: "Dell U2723",
        Category: "Monitor",
        Status: "In use",
        Serial: "DM-2723-44",
        Value: 600,
        "Assigned to": "Sam",
        Purchased: "2025-09-12",
      }),
      rec({
        Name: "iPhone 15",
        Category: "Phone",
        Status: "In storage",
        Serial: "IP-15-882",
        Value: 900,
        Purchased: "2026-01-20",
      }),
      rec({
        Name: "Standing desk",
        Category: "Furniture",
        Status: "Repair",
        Serial: "SD-310",
        Value: 480,
        "Assigned to": "Lee",
        Purchased: "2024-11-03",
      }),
    ],
  );
  return singleTableApp(t, (tableId) => ({
    name: "Asset inventory",
    forms: [
      {
        id: makeAppId(),
        name: "Register asset",
        tableId,
        fieldNames: [
          "Name",
          "Category",
          "Status",
          "Serial",
          "Value",
          "Assigned to",
          "Purchased",
        ],
      },
    ],
    dashboard: {
      title: "Inventory",
      widgets: [
        { id: makeAppId(), kind: "count", tableId, title: "Assets" },
        {
          id: makeAppId(),
          kind: "rollup",
          tableId,
          title: "Total value",
          valueField: "Value",
          aggregation: "SUM",
        },
        {
          id: makeAppId(),
          kind: "chart",
          tableId,
          title: "Value by category",
          groupByField: "Category",
          valueField: "Value",
          aggregation: "SUM",
        },
        {
          id: makeAppId(),
          kind: "group",
          tableId,
          title: "By status",
          groupByField: "Status",
        },
      ],
    },
  }));
}

/** The built-in starter bases, in gallery display order. */
export const BASE_TEMPLATES: ReadonlyArray<BaseTemplate> = [
  {
    id: "crm",
    label: "CRM",
    description: "Track contacts and deals through a sales pipeline.",
    category: "Sales",
    build: buildCrm,
  },
  {
    id: "project-tracker",
    label: "Project tracker",
    description: "Plan tasks with status, priority, owners and due dates.",
    category: "Projects",
    build: buildProjectTracker,
  },
  {
    id: "content-calendar",
    label: "Content calendar",
    description: "Schedule content across channels from idea to published.",
    category: "Content",
    build: buildContentCalendar,
  },
  {
    id: "applicant-tracker",
    label: "Applicant tracker",
    description: "Move candidates through your hiring funnel.",
    category: "HR",
    build: buildApplicantTracker,
  },
  {
    id: "asset-inventory",
    label: "Asset inventory",
    description: "Keep tabs on equipment, value and assignment.",
    category: "Operations",
    build: buildAssetInventory,
  },
];

/** Find a built-in template by id, or `null`. Total — safe with absent id. */
export function findBaseTemplate(
  id: string | undefined | null,
): BaseTemplate | null {
  if (id == null) return null;
  return BASE_TEMPLATES.find((t) => t.id === id) ?? null;
}
