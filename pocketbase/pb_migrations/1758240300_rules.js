/// <reference path="../pb_data/types.d.ts" />

/**
 * Field Checkout — access rules.
 *
 * Runs last, once every collection exists. PocketBase validates a rule at the
 * moment the collection is saved, so any rule naming `project_members` has to
 * wait until that collection has been created — otherwise the save fails with
 * `unknown field "project"` and the backend crash-loops.
 *
 * The shape of every rule below is the same: you may touch a record if you are
 * an admin, or if there is a `project_members` row joining you to that
 * project. Membership is the unit of access; there is no "everyone can see
 * everything" state.
 *
 * Each collection is applied in its own try/catch. If one fails it stays at
 * the fallback from the first migration — signed-in users only — which is
 * tighter than public and does not take the server down. The failure is
 * logged so you can set it by hand in the dashboard.
 */
migrate(
  (app) => {
    const ADMIN = "@request.auth.role = 'admin'";
    // The record is a project: match on its own id.
    const MEMBER_OF_SELF =
      "@collection.project_members.project ?= id && " +
      "@collection.project_members.user ?= @request.auth.id";
    // The record belongs to a project: match on its project field.
    const MEMBER_OF_PARENT =
      "@collection.project_members.project ?= project && " +
      "@collection.project_members.user ?= @request.auth.id";
    const LEAD_OF_SELF =
      MEMBER_OF_SELF + " && @collection.project_members.role ?= 'lead'";

    const rules = {
      projects: {
        listRule: ADMIN + " || " + MEMBER_OF_SELF,
        viewRule: ADMIN + " || " + MEMBER_OF_SELF,
        createRule: "@request.auth.role = 'lead' || " + ADMIN,
        updateRule: ADMIN + " || " + LEAD_OF_SELF,
        deleteRule: ADMIN,
      },
      points: {
        listRule: ADMIN + " || " + MEMBER_OF_PARENT,
        viewRule: ADMIN + " || " + MEMBER_OF_PARENT,
        createRule: MEMBER_OF_PARENT,
        updateRule: MEMBER_OF_PARENT,
        deleteRule: ADMIN,
      },
      events: {
        listRule: ADMIN + " || " + MEMBER_OF_PARENT,
        viewRule: ADMIN + " || " + MEMBER_OF_PARENT,
        createRule: "@request.auth.id = by && " + MEMBER_OF_PARENT,
        // The audit trail is append-only. Nobody edits or deletes an event,
        // including an admin — that is the point of keeping one.
        updateRule: null,
        deleteRule: null,
      },
      issues: {
        listRule: ADMIN + " || " + MEMBER_OF_PARENT,
        viewRule: ADMIN + " || " + MEMBER_OF_PARENT,
        createRule: MEMBER_OF_PARENT,
        updateRule: MEMBER_OF_PARENT,
        deleteRule: ADMIN,
      },
    };

    for (const name of Object.keys(rules)) {
      try {
        const collection = app.findCollectionByNameOrId(name);
        const r = rules[name];
        for (const key of Object.keys(r)) collection[key] = r[key];
        app.save(collection);
        console.log("[rules] " + name + ": ok");
      } catch (err) {
        console.log(
          "[rules] " + name + ": FAILED - " + err +
          " - stays at signed-in-users-only; set it in the dashboard under " +
          "this collection's API Rules tab"
        );
      }
    }
  },

  (app) => {
    const open = '@request.auth.id != ""';
    for (const name of ["projects", "points", "events", "issues"]) {
      try {
        const collection = app.findCollectionByNameOrId(name);
        collection.listRule = open;
        collection.viewRule = open;
        collection.createRule = open;
        collection.updateRule = open;
        collection.deleteRule = null;
        app.save(collection);
      } catch (e) {
        /* already gone */
      }
    }
  }
);
