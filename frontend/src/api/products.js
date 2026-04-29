import { apiFetch } from "./client.js";

export const productsApi = {
  list: (category) =>
    apiFetch("/products", { query: category ? { category } : undefined }),
  get: (sku) => apiFetch(`/products/${encodeURIComponent(sku)}`),
  create: (data) =>
    apiFetch("/products", { method: "POST", auth: true, body: data }),
  update: (sku, data) =>
    apiFetch(`/products/${encodeURIComponent(sku)}`, {
      method: "PUT",
      auth: true,
      body: data,
    }),
  remove: (sku) =>
    apiFetch(`/products/${encodeURIComponent(sku)}`, {
      method: "DELETE",
      auth: true,
    }),
};
