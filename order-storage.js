// Frontend helper for storing the last order ID in device storage.
// Use this in your browser-based checkout UI.

export function saveOrderId(orderId) {
  if (typeof window === 'undefined' || !window.localStorage) {
    return;
  }
  localStorage.setItem('gadgetfinds_order_id', String(orderId));
}

export function getOrderId() {
  if (typeof window === 'undefined' || !window.localStorage) {
    return null;
  }
  return localStorage.getItem('gadgetfinds_order_id');
}

export function clearOrderId() {
  if (typeof window === 'undefined' || !window.localStorage) {
    return;
  }
  localStorage.removeItem('gadgetfinds_order_id');
}

export async function fetchCheckout(orderId) {
  const response = await fetch(`/api/checkout/${orderId}`);
  if (!response.ok) {
    throw new Error('Failed to load checkout details');
  }
  return response.json();
}
