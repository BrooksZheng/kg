export async function loadShipmentStatus(shipmentId) {
  const response = await fetch(`https://shipment-data.example.test/shipments/${shipmentId}`);
  if (!response.ok) throw new Error("upstream shipment lookup failed");
  return response.json();
}
