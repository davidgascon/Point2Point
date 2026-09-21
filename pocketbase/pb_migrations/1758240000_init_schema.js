/// <reference path="../pb_data/types.d.ts" />

/**
 * Field Checkout — collections.
 *
 * Access rules that reference another collection live in a later migration.
 * PocketBase validates a rule when the collection is saved, so a rule naming
 * `project_members` fails if that collection has not been created yet.
 * Until the rules migration runs, every collection is signed-in-users-only.
 *
 * Indexes live in the next migration on purpose. Creating them inline fails
 * on some PocketBase versions because the helper builds its SQL before the
 * new table's columns exist, and a failed index takes the whole migration
 * down with it.
 *
 * Written against the PocketBase 0.23+ JS migration API (`migrate((app) => …)`).
 * If your pinned PB_VERSION is older than 0.23 the API is different
 * (`new Dao(db)`); see the README for how to check and what to do.
 *
 * Roles live on the user record:
 *   tech   — verifies points on projects they are a member of
 *   lead   — the above, plus invite members and export
 *   admin  — everything, plus the PocketBase dashboard
 */
migrate(
  (app) => {
    // ---------------------------------------------------------------- users
    // PocketBase creates a `users` auth collection by default. We extend it
    // rather than replace it, so password reset and email verification keep
    // working out of the box.
    const users = app.findCollectionByNameOrId("users");

    users.fields.add(
      new TextField({
        name: "initials",
        required: true,
        min: 1,
        max: 4,
        // These initials are what lands in the Point To Point column of the
        // exported sheet, so they are part of the permanent record.
        presentable: true,
      })
    );
    users.fields.add(
      new SelectField({
        name: "role",
        required: true,
        maxSelect: 1,
        values: ["tech", "lead", "admin"],
      })
    );
    users.fields.add(new BoolField({ name: "active" }));
    users.fields.add(new TextField({ name: "phone", max: 40 }));


    // Nobody self-registers into the system; a lead or admin creates accounts.
    users.createRule = null;
    users.listRule = '@request.auth.id != ""';
    users.viewRule = '@request.auth.id != ""';
    users.updateRule = "id = @request.auth.id || @request.auth.role = 'admin'";
    users.deleteRule = "@request.auth.role = 'admin'";

    app.save(users);

    // ------------------------------------------------------------- projects
    const projects = new Collection({
      name: "projects",
      type: "base",
      fields: [
        new TextField({ name: "name", required: true, max: 200, presentable: true }),
        new TextField({ name: "job", max: 60 }),
        new TextField({ name: "location", max: 300 }),
        new SelectField({
          name: "status",
          maxSelect: 1,
          values: ["active", "archived"],
        }),
        // The original workbook, kept so exports can be written back into it
        // with all formatting and macros intact.
        new FileField({
          name: "template",
          maxSelect: 1,
          maxSize: 26214400,
          mimeTypes: [
            "application/vnd.ms-excel.sheet.macroEnabled.12",
            "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
          ],
        }),
        new JSONField({ name: "settings", maxSize: 200000 }),
        new RelationField({
          name: "created_by",
          collectionId: users.id,
          maxSelect: 1,
        }),
      ],
      listRule:
        '@request.auth.id != ""',
      viewRule:
        '@request.auth.id != ""',
      createRule: "@request.auth.role = 'lead' || @request.auth.role = 'admin'",
      updateRule:
        '@request.auth.id != ""',
      deleteRule: "@request.auth.role = 'admin'",
    });
    app.save(projects);

    // ------------------------------------------------------ project_members
    const members = new Collection({
      name: "project_members",
      type: "base",
      fields: [
        new RelationField({
          name: "project",
          collectionId: projects.id,
          required: true,
          maxSelect: 1,
          cascadeDelete: true,
        }),
        new RelationField({
          name: "user",
          collectionId: users.id,
          required: true,
          maxSelect: 1,
          cascadeDelete: true,
        }),
        new SelectField({
          name: "role",
          required: true,
          maxSelect: 1,
          values: ["tech", "lead"],
        }),
        new RelationField({ name: "added_by", collectionId: users.id, maxSelect: 1 }),
      ],
      listRule: '@request.auth.id != ""',
      viewRule: '@request.auth.id != ""',
      createRule:
        "@request.auth.role = 'lead' || @request.auth.role = 'admin'",
      updateRule: "@request.auth.role = 'admin'",
      deleteRule:
        "@request.auth.role = 'lead' || @request.auth.role = 'admin'",
    });
    app.save(members);

    // --------------------------------------------------------------- points
    const points = new Collection({
      name: "points",
      type: "base",
      fields: [
        new RelationField({
          name: "project",
          collectionId: projects.id,
          required: true,
          maxSelect: 1,
          cascadeDelete: true,
        }),
        new TextField({ name: "unit", max: 120 }),
        new TextField({ name: "tag", required: true, max: 200, presentable: true }),
        new TextField({ name: "type", max: 10 }),
        new TextField({ name: "descr", max: 400 }),
        new TextField({ name: "addr", max: 80 }),
        new TextField({ name: "controller", max: 200 }),
        // Row in the source workbook, so an export lands on the right line
        // even if a tag was edited in the field.
        new NumberField({ name: "sheet_row" }),
        new SelectField({
          name: "status",
          maxSelect: 1,
          values: ["Installed", "Wired", "Pass", "Fail", "Issue"],
        }),
        new RelationField({ name: "by", collectionId: users.id, maxSelect: 1 }),
        new NumberField({ name: "at" }),
        // Verbatim sign-off text imported from the sheet ("DG 9/4/26"),
        // preserved so historic entries are never rewritten.
        new TextField({ name: "imported_by", max: 60 }),
        new TextField({ name: "installed_by", max: 60 }),
        new BoolField({ name: "p2p_na" }),
        new JSONField({ name: "checks", maxSize: 4000 }),
        new JSONField({ name: "reading", maxSize: 4000 }),
        new TextField({ name: "notes", max: 2000 }),
      ],
      listRule:
        '@request.auth.id != ""',
      viewRule:
        '@request.auth.id != ""',
      createRule:
        '@request.auth.id != ""',
      updateRule:
        '@request.auth.id != ""',
      deleteRule: "@request.auth.role = 'admin'",
    });
    app.save(points);

    // --------------------------------------------------------------- events
    // Append-only. A point's current state is the most recent event; the
    // phone generates the id so a retried sync is a no-op rather than a
    // duplicate.
    const events = new Collection({
      name: "events",
      type: "base",
      fields: [
        new TextField({ name: "client_id", required: true, max: 60 }),
        new RelationField({
          name: "project",
          collectionId: projects.id,
          required: true,
          maxSelect: 1,
          cascadeDelete: true,
        }),
        new RelationField({
          name: "point",
          collectionId: points.id,
          maxSelect: 1,
          cascadeDelete: true,
        }),
        new SelectField({
          name: "kind",
          required: true,
          maxSelect: 1,
          values: ["verdict", "life", "checks", "edit", "issue", "resolve"],
        }),
        new JSONField({ name: "payload", maxSize: 20000 }),
        new RelationField({ name: "by", collectionId: users.id, maxSelect: 1 }),
        new NumberField({ name: "at", required: true }),
      ],
      listRule:
        '@request.auth.id != ""',
      viewRule:
        '@request.auth.id != ""',
      createRule:
        '@request.auth.id != ""',
      // The audit trail is never edited or deleted, by anyone.
      updateRule: null,
      deleteRule: null,
    });
    app.save(events);

    // --------------------------------------------------------------- issues
    const issues = new Collection({
      name: "issues",
      type: "base",
      fields: [
        new RelationField({
          name: "project",
          collectionId: projects.id,
          required: true,
          maxSelect: 1,
          cascadeDelete: true,
        }),
        new SelectField({
          name: "scope",
          required: true,
          maxSelect: 1,
          values: ["point", "unit", "job"],
        }),
        new RelationField({
          name: "point",
          collectionId: points.id,
          maxSelect: 1,
          cascadeDelete: true,
        }),
        new TextField({ name: "unit", max: 120 }),
        new SelectField({
          name: "kind",
          required: true,
          maxSelect: 1,
          values: ["Defect", "Rework", "RFI", "Observation"],
        }),
        new TextField({ name: "descr", required: true, max: 4000 }),
        new SelectField({
          name: "party",
          maxSelect: 1,
          values: ["Controls", "Electrical", "Mechanical", "TAB", "Engineering", "Other"],
        }),
        new SelectField({
          name: "priority",
          maxSelect: 1,
          values: ["Low", "Medium", "High"],
        }),
        new NumberField({ name: "hours" }),
        new BoolField({ name: "blocks" }),
        // Photos go here, not through the event queue — a dozen images must
        // never hold up a sync of text records.
        new FileField({
          name: "photos",
          maxSelect: 12,
          maxSize: 8388608,
          mimeTypes: ["image/jpeg", "image/png", "image/webp"],
          thumbs: ["120x120", "800x800"],
        }),
        new BoolField({ name: "resolved" }),
        new RelationField({ name: "by", collectionId: users.id, maxSelect: 1 }),
        new RelationField({ name: "resolved_by", collectionId: users.id, maxSelect: 1 }),
        new NumberField({ name: "at" }),
        new NumberField({ name: "resolved_at" }),
      ],
      listRule:
        '@request.auth.id != ""',
      viewRule:
        '@request.auth.id != ""',
      createRule:
        '@request.auth.id != ""',
      updateRule:
        '@request.auth.id != ""',
      deleteRule: "@request.auth.role = 'admin'",
    });
    app.save(issues);
  },

  // ------------------------------------------------------------------- down
  (app) => {
    ["issues", "events", "points", "project_members", "projects"].forEach((n) => {
      try {
        app.delete(app.findCollectionByNameOrId(n));
      } catch (e) {
        /* already gone */
      }
    });

    const users = app.findCollectionByNameOrId("users");
    ["initials", "role", "active", "phone"].forEach((f) => {
      try {
        users.fields.removeByName(f);
      } catch (e) {
        /* not present */
      }
    });
    app.save(users);
  }
);
