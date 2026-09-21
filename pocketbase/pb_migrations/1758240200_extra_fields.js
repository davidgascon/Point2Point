/// <reference path="../pb_data/types.d.ts" />

/**
 * Field Checkout — fields added after the first release.
 *
 * Wrapped so a failure here cannot crash-loop the backend; anything that
 * does not apply can be added by hand in the dashboard.
 */
migrate(
  (app) => {
    try {
      const points = app.findCollectionByNameOrId("points");
      if (!points.fields.getByName("added_in_field")) {
        // Points a tech created at the panel. They have no row in the source
        // workbook, so the exporter stages them on their own sheet.
        points.fields.add(new BoolField({ name: "added_in_field" }));
        app.save(points);
        console.log("[fields] points.added_in_field: added");
      }
    } catch (err) {
      console.log("[fields] points.added_in_field: FAILED - " + err);
    }
  },
  (app) => {
    try {
      const points = app.findCollectionByNameOrId("points");
      points.fields.removeByName("added_in_field");
      app.save(points);
    } catch (e) {}
  }
);
