import { apiFetch } from "./client.js";

export const cartApi = {
  get: () => apiFetch("/cart", { auth: true }),
  clear: () => apiFetch("/cart", { method: "DELETE", auth: true }),
  addItem: (sku, qty) =>
    apiFetch("/cart/items", {
      method: "POST",
      auth: true,
      body: { sku, qty },
    }),
  setItem: (sku, qty) =>
    apiFetch(`/cart/items/${encodeURIComponent(sku)}`, {
      method: "PUT",
      auth: true,
      body: { qty },
    }),
  removeItem: (sku) =>
    apiFetch(`/cart/items/${encodeURIComponent(sku)}`, {
      method: "DELETE",
      auth: true,
    }),
};
