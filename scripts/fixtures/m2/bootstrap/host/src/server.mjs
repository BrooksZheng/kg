import { loadOrder } from "./order-service.mjs";

export function createApplication(router) {
  router.get("/orders/:id", async (request) => {
    return loadOrder(request.params.id);
  });
}

export function start(router) {
  return createApplication(router);
}
