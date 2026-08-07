export async function loadOrder(orderId) {
  const response = await fetch(`https://orders.example.test/orders/${orderId}`);
  return response.json();
}
