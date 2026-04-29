import { apiFetch } from "./client.js";

export const ordersApi = {
  place: (payload) =>
    apiFetch("/orders", { method: "POST", auth: true, body: payload }),
  myList: () => apiFetch("/me/orders", { auth: true }),
  myGet: (orderId) =>
    apiFetch(`/me/orders/${encodeURIComponent(orderId)}`, { auth: true }),
};
