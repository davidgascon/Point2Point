/// <reference path="../pb_data/types.d.ts" />

/**
 * Field Checkout — soft delete for points.
 *
 * A point is never actually removed. The row still exists in the source
 * workbook, the export has to show it as deleted rather than silently drop it,
 * and someone will eventually ask who removed it and why. So we mark it.
 *
 * Wrapped so a failure cannot crash-loop the backend.
 */
migrate(
  (app) => {
    try {
      const points = app.findCollectionByNameOrId("points");

      if (!points.fields.getByName("deleted")) {
        points.fields.add(new BoolField({ name: "deleted" }));
      }
      if (!points.fields.getByName("deleted_by")) {
        const users = app.findCollectionByNameOrId("users");
        points.fields.add(new RelationField({
          name: "deleted_by", collectionId: users.id, maxSelect: 1,
        }));
      }
      if (!points.fields.getByName("deleted_at")) {
        points.fields.add(new NumberField({ name: "deleted_at" }));
      }
      if (!points.fields.getByName("delete_reason")) {
        points.fields.add(new TextField({ name: "delete_reason", max: 500 }));
      }

      app.save(points);
      console.log("[fields] points soft-delete fields: added");
    } catch (err) {
      console.log("[fields] points soft-delete fields: FAILED - " + err +
                  " - add deleted (bool), deleted_by (relation->users), " +
                  "deleted_at (number) and delete_reason (text) by hand");
    }
  },

  (app) => {
    try {
      const points = app.findCollectionByNameOrId("points");
      ["deleted", "deleted_by", "deleted_at", "delete_reason"].forEach((f) => {
        try { points.fields.removeByName(f); } catch (e) {}
      });
      app.save(points);
    } catch (e) {}
  }
);
