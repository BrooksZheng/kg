import { loadParcelStatus } from "./order-store.mjs";

export function registerRoutes(router) {
  router.get("/parcels/:id", async (request) => {
    return loadParcelStatus(request.params.id);
  });
}

export function start(router) {
  return registerRoutes(router);
}
