/// <reference path="../pb_data/types.d.ts" />

/**
 * Field Checkout — issue tracking.
 *
 * Three additions to the defect log rather than a second tracker beside it:
 *
 *   caused_by  who created the problem, which is not the same question as
 *              `party` (who has to fix it). A controls defect caused by the
 *              electrician is billable to them; the existing field cannot
 *              express that.
 *   status     Open / In progress / Waiting / Resolved. `resolved` stays as
 *              the boolean everything already filters on, kept in step.
 *   updates    an append-only thread, so "chased this twice" is on the record
 *              instead of in somebody's head.
 *
 * Wrapped so a failure cannot crash-loop the backend.
 */
migrate(
  (app) => {
    try {
      const issues = app.findCollectionByNameOrId("issues");

      if (!issues.fields.getByName("caused_by")) {
        issues.fields.add(new SelectField({
          name: "caused_by",
          maxSelect: 1,
          values: ["Unknown", "Controls", "Electrical", "Mechanical",
                   "TAB", "Engineering", "General", "Owner", "Other"],
        }));
      }
      if (!issues.fields.getByName("status")) {
        issues.fields.add(new SelectField({
          name: "status",
          maxSelect: 1,
          values: ["Open", "In progress", "Waiting", "Resolved"],
        }));
      }
      if (!issues.fields.getByName("updates")) {
        issues.fields.add(new JSONField({ name: "updates", maxSize: 60000 }));
      }

      app.save(issues);
      console.log("[fields] issues tracking fields: added");
    } catch (err) {
      console.log("[fields] issues tracking fields: FAILED - " + err +
                  " - add caused_by (select), status (select) and " +
                  "updates (json) by hand");
    }
  },

  (app) => {
    try {
      const issues = app.findCollectionByNameOrId("issues");
      ["caused_by", "status", "updates"].forEach((f) => {
        try { issues.fields.removeByName(f); } catch (e) {}
      });
      app.save(issues);
    } catch (e) {}
  }
);
