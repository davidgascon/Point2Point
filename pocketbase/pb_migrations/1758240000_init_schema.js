/// <reference path="../pb_data/types.d.ts" />

/**
 * Field Checkout — collections.
 *
 * Fields are attached with `collection.fields.add(...)` after constructing the
 * collection, never passed into `new Collection({ fields: [...] })`. The
 * constructor form is silently ignored in this PocketBase version: the
 * collection gets created with only its system columns, and every index and
 * rule that follows then fails with "no such column".
 *
 * Access rules that reference another collection live in a later migration,
 * because PocketBase validates a rule when the collection is saved and the
 * collection it names may not exist yet.
 *
 * Roles live on the user record:
 *   tech   — verifies points on projects they are a member of
 *   lead   — the above, plus invite members and export
 *   admin  — everything, plus the PocketBase dashboard
 */
migrate(
  (app) => {
    const AUTHED = '@request.auth.id != ""';

    // ---------------------------------------------------------------- users
    // PocketBase ships a `users` auth collection. Extend it rather than
    // replace it, so password reset and verification keep working.
    const users = app.findCollectionByNameOrId("users");

    if (!users.fields.getByName("initials")) {
      // These initials land in the Point To Point column of the exported
      // sheet, so they are part of the permanent record.
      users.fields.add(
        new TextField({ name: "initials", required: true, min: 1, max: 4, presentable: true })
      );
    }
    if (!users.fields.getByName("role")) {
      users.fields.add(
        new SelectField({ name: "role", required: true, maxSelect: 1, values: ["tech", "lead", "admin"] })
      );
    }
    if (!users.fields.getByName("active")) users.fields.add(new BoolField({ name: "active" }));
    if (!users.fields.getByName("phone")) users.fields.add(new TextField({ name: "phone", max: 40 }));

    users.listRule = AUTHED;
    users.viewRule = AUTHED;
    users.updateRule = "id = @request.auth.id || @request.auth.role = 'admin'";
    users.deleteRule = "@request.auth.role = 'admin'";
    app.save(users);

    // ------------------------------------------------------------- projects
    const projects = new Collection({ name: "projects", type: "base" });
    projects.fields.add(new TextField({ name: "name", required: true, max: 200, presentable: true }));
    projects.fields.add(new TextField({ name: "job", max: 60 }));
    projects.fields.add(new TextField({ name: "location", max: 300 }));
    projects.fields.add(new SelectField({ name: "status", maxSelect: 1, values: ["active", "archived"] }));
    // The original workbook, so exports can be written back into it with all
    // formatting and macros intact.
    projects.fields.add(new FileField({
      name: "template", maxSelect: 1, maxSize: 26214400,
      mimeTypes: [
        "application/vnd.ms-excel.sheet.macroEnabled.12",
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      ],
    }));
    projects.fields.add(new JSONField({ name: "settings", maxSize: 200000 }));
    projects.fields.add(new RelationField({ name: "created_by", collectionId: users.id, maxSelect: 1 }));
    projects.listRule = AUTHED;
    projects.viewRule = AUTHED;
    projects.createRule = "@request.auth.role = 'lead' || @request.auth.role = 'admin'";
    projects.updateRule = AUTHED;
    projects.deleteRule = "@request.auth.role = 'admin'";
    app.save(projects);

    // ------------------------------------------------------ project_members
    const members = new Collection({ name: "project_members", type: "base" });
    members.fields.add(new RelationField({
      name: "project", collectionId: projects.id, required: true, maxSelect: 1, cascadeDelete: true,
    }));
    members.fields.add(new RelationField({
      name: "user", collectionId: users.id, required: true, maxSelect: 1, cascadeDelete: true,
    }));
    members.fields.add(new SelectField({
      name: "role", required: true, maxSelect: 1, values: ["tech", "lead"],
    }));
    members.fields.add(new RelationField({ name: "added_by", collectionId: users.id, maxSelect: 1 }));
    members.listRule = AUTHED;
    members.viewRule = AUTHED;
    members.createRule = "@request.auth.role = 'lead' || @request.auth.role = 'admin'";
    members.updateRule = "@request.auth.role = 'admin'";
    members.deleteRule = "@request.auth.role = 'lead' || @request.auth.role = 'admin'";
    app.save(members);

    // --------------------------------------------------------------- points
    const points = new Collection({ name: "points", type: "base" });
    points.fields.add(new RelationField({
      name: "project", collectionId: projects.id, required: true, maxSelect: 1, cascadeDelete: true,
    }));
    points.fields.add(new TextField({ name: "unit", max: 120 }));
    points.fields.add(new TextField({ name: "tag", required: true, max: 200, presentable: true }));
    points.fields.add(new TextField({ name: "type", max: 10 }));
    points.fields.add(new TextField({ name: "descr", max: 400 }));
    points.fields.add(new TextField({ name: "addr", max: 80 }));
    points.fields.add(new TextField({ name: "controller", max: 200 }));
    // Row in the source workbook, so an export lands on the right line even
    // if a tag was corrected in the field.
    points.fields.add(new NumberField({ name: "sheet_row" }));
    points.fields.add(new SelectField({
      name: "status", maxSelect: 1, values: ["Installed", "Wired", "Pass", "Fail", "Issue"],
    }));
    points.fields.add(new RelationField({ name: "by", collectionId: users.id, maxSelect: 1 }));
    points.fields.add(new NumberField({ name: "at" }));
    // Verbatim sign-off text imported from the sheet ("DG 9/4/26"), preserved
    // so historic entries are never rewritten.
    points.fields.add(new TextField({ name: "imported_by", max: 60 }));
    points.fields.add(new TextField({ name: "installed_by", max: 60 }));
    points.fields.add(new BoolField({ name: "p2p_na" }));
    // Points a tech created at the panel; they have no row in the workbook.
    points.fields.add(new BoolField({ name: "added_in_field" }));
    points.fields.add(new JSONField({ name: "checks", maxSize: 4000 }));
    points.fields.add(new JSONField({ name: "reading", maxSize: 4000 }));
    points.fields.add(new TextField({ name: "notes", max: 2000 }));
    points.listRule = AUTHED;
    points.viewRule = AUTHED;
    points.createRule = AUTHED;
    points.updateRule = AUTHED;
    points.deleteRule = "@request.auth.role = 'admin'";
    app.save(points);

    // --------------------------------------------------------------- events
    // Append-only. A point's current state is the most recent event; the phone
    // generates client_id so a retried sync is a no-op, not a duplicate.
    const events = new Collection({ name: "events", type: "base" });
    events.fields.add(new TextField({ name: "client_id", required: true, max: 60 }));
    events.fields.add(new RelationField({
      name: "project", collectionId: projects.id, required: true, maxSelect: 1, cascadeDelete: true,
    }));
    events.fields.add(new RelationField({
      name: "point", collectionId: points.id, maxSelect: 1, cascadeDelete: true,
    }));
    events.fields.add(new SelectField({
      name: "kind", required: true, maxSelect: 1,
      values: ["verdict", "life", "checks", "edit", "issue", "resolve"],
    }));
    events.fields.add(new JSONField({ name: "payload", maxSize: 20000 }));
    events.fields.add(new RelationField({ name: "by", collectionId: users.id, maxSelect: 1 }));
    events.fields.add(new NumberField({ name: "at", required: true }));
    events.listRule = AUTHED;
    events.viewRule = AUTHED;
    events.createRule = AUTHED;
    // The audit trail is never edited or deleted, by anyone.
    events.updateRule = null;
    events.deleteRule = null;
    app.save(events);

    // --------------------------------------------------------------- issues
    const issues = new Collection({ name: "issues", type: "base" });
    issues.fields.add(new RelationField({
      name: "project", collectionId: projects.id, required: true, maxSelect: 1, cascadeDelete: true,
    }));
    issues.fields.add(new SelectField({
      name: "scope", required: true, maxSelect: 1, values: ["point", "unit", "job"],
    }));
    issues.fields.add(new RelationField({
      name: "point", collectionId: points.id, maxSelect: 1, cascadeDelete: true,
    }));
    issues.fields.add(new TextField({ name: "unit", max: 120 }));
    issues.fields.add(new SelectField({
      name: "kind", required: true, maxSelect: 1,
      values: ["Defect", "Rework", "RFI", "Observation"],
    }));
    issues.fields.add(new TextField({ name: "descr", required: true, max: 4000 }));
    issues.fields.add(new SelectField({
      name: "party", maxSelect: 1,
      values: ["Controls", "Electrical", "Mechanical", "TAB", "Engineering", "Other"],
    }));
    issues.fields.add(new SelectField({
      name: "priority", maxSelect: 1, values: ["Low", "Medium", "High"],
    }));
    issues.fields.add(new NumberField({ name: "hours" }));
    issues.fields.add(new BoolField({ name: "blocks" }));
    // Photos live here, not in the event queue — a dozen images must never
    // hold up a sync of text records.
    issues.fields.add(new FileField({
      name: "photos", maxSelect: 12, maxSize: 8388608,
      mimeTypes: ["image/jpeg", "image/png", "image/webp"],
      thumbs: ["120x120", "800x800"],
    }));
    issues.fields.add(new BoolField({ name: "resolved" }));
    issues.fields.add(new RelationField({ name: "by", collectionId: users.id, maxSelect: 1 }));
    issues.fields.add(new RelationField({ name: "resolved_by", collectionId: users.id, maxSelect: 1 }));
    issues.fields.add(new NumberField({ name: "at" }));
    issues.fields.add(new NumberField({ name: "resolved_at" }));
    issues.listRule = AUTHED;
    issues.viewRule = AUTHED;
    issues.createRule = AUTHED;
    issues.updateRule = AUTHED;
    issues.deleteRule = "@request.auth.role = 'admin'";
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
    try {
      const users = app.findCollectionByNameOrId("users");
      ["initials", "role", "active", "phone"].forEach((f) => {
        try { users.fields.removeByName(f); } catch (e) {}
      });
      app.save(users);
    } catch (e) {}
  }
);
