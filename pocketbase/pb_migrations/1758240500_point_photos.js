/// <reference path="../pb_data/types.d.ts" />

/**
 * Field Checkout — photos on a point.
 *
 * Separate from defect photos. A defect photo is evidence of a problem; these
 * are a record of what was found at the device — the sensor, the nameplate,
 * the wire landing — on points that passed perfectly well.
 */
migrate(
  (app) => {
    try {
      const points = app.findCollectionByNameOrId("points");
      if (!points.fields.getByName("photos")) {
        points.fields.add(new FileField({
          name: "photos",
          maxSelect: 8,
          maxSize: 8388608,
          mimeTypes: ["image/jpeg", "image/png", "image/webp"],
          thumbs: ["120x120", "800x800"],
        }));
        app.save(points);
        console.log("[fields] points.photos: added");
      } else {
        console.log("[fields] points.photos: already there");
      }
    } catch (err) {
      console.log("[fields] points.photos: FAILED - " + err +
                  " - add a File field named photos (max 8) by hand");
    }
  },

  (app) => {
    try {
      const points = app.findCollectionByNameOrId("points");
      points.fields.removeByName("photos");
      app.save(points);
    } catch (e) {}
  }
);
