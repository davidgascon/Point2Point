/// <reference path="../pb_data/types.d.ts" />

/**
 * Field Checkout — indexes.
 *
 * Kept separate from the collections migration. At this point every table and
 * column already exists, so the SQL below is valid. Indexes are written as
 * full CREATE INDEX statements on the collection's `indexes` array, which is
 * how PocketBase stores them natively — the `addIndex()` helper builds its SQL
 * against a collection that has not been persisted yet and fails with
 * "no such column".
 *
 * Each collection is handled in its own try/catch so one bad index cannot
 * crash-loop the whole backend. Anything that fails is logged and can be
 * added by hand in the dashboard under the collection's Indexes tab.
 */
migrate(
  (app) => {
    const wanted = {
      // Two people signing as "DG" would make the record ambiguous forever.
      users: [
        "CREATE UNIQUE INDEX `idx_users_initials` ON `users` (`initials`)",
      ],
      // One membership row per person per project.
      project_members: [
        "CREATE UNIQUE INDEX `idx_member_unique` ON `project_members` (`project`, `user`)",
      ],
      // A tag is unique within a unit on a project; the second index is what
      // makes loading a project's point list fast.
      points: [
        "CREATE UNIQUE INDEX `idx_point_unique` ON `points` (`project`, `unit`, `tag`)",
        "CREATE INDEX `idx_point_project` ON `points` (`project`)",
      ],
      // client_id is generated on the phone. The unique index is what makes a
      // retried sync a no-op instead of a duplicate record.
      events: [
        "CREATE UNIQUE INDEX `idx_event_client` ON `events` (`client_id`)",
        "CREATE INDEX `idx_event_project_at` ON `events` (`project`, `at`)",
      ],
      issues: [
        "CREATE INDEX `idx_issue_project` ON `issues` (`project`, `resolved`)",
      ],
    };

    for (const name of Object.keys(wanted)) {
      try {
        const collection = app.findCollectionByNameOrId(name);
        const existing = collection.indexes || [];
        const merged = existing.slice();

        for (const sql of wanted[name]) {
          // Match on the index name so re-running is harmless.
          const idxName = sql.match(/INDEX\s+`([^`]+)`/)[1];
          const already = merged.some((s) => s.indexOf("`" + idxName + "`") !== -1);
          if (!already) merged.push(sql);
        }

        collection.indexes = merged;
        app.save(collection);
        console.log("[indexes] " + name + ": ok");
      } catch (err) {
        // Deliberately swallowed. An index is an optimisation and a guard
        // rail; losing one is not worth taking the server down for.
        console.log(
          "[indexes] " + name + ": FAILED — " + err +
          " — add it by hand in the dashboard under this collection's Indexes tab"
        );
      }
    }
  },

  (app) => {
    const names = ["users", "project_members", "points", "events", "issues"];
    const ours = /idx_(users_initials|member_unique|point_unique|point_project|event_client|event_project_at|issue_project)/;
    for (const name of names) {
      try {
        const collection = app.findCollectionByNameOrId(name);
        collection.indexes = (collection.indexes || []).filter((s) => !ours.test(s));
        app.save(collection);
      } catch (e) {
        /* collection already gone */
      }
    }
  }
);
