import { loadShipmentStatus } from "./shipment-store.mjs";

export function registerRoutes(router) {
  router.get("/shipments/:id", async (request) => {
    return loadShipmentStatus(request.params.id);
  });
}

export function start(router) {
  return registerRoutes(router);
}
