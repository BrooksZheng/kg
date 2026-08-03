export async function loadParcelStatus(parcelId) {
  const response = await fetch(`https://parcel-data.example.test/parcels/${parcelId}`);
  if (!response.ok) throw new Error(`parcel lookup failed: ${response.status}`);
  return response.json();
}
