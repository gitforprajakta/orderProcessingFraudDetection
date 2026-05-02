import { apiFetch } from "./client.js";

export const adminApi = {
  listOrders: (status) =>
    apiFetch("/admin/orders", {
      auth: true,
      query: status ? { status } : undefined,
    }),
  getOrder: (orderId) =>
    apiFetch(`/admin/orders/${encodeURIComponent(orderId)}`, { auth: true }),
  decideOrder: (orderId, decision, receiptHandle) =>
    apiFetch(
      `/admin/orders/${encodeURIComponent(orderId)}/decision`,
      {
        method: "POST",
        auth: true,
        body: receiptHandle
          ? { decision, receiptHandle }
          : { decision },
      }
    ),
  listReviewQueue: () =>
    apiFetch("/admin/review-queue", { auth: true }),

  stats: () => apiFetch("/admin/stats", { auth: true }),

  listProducts: () => apiFetch("/admin/products", { auth: true }),
  getProduct: (sku) =>
    apiFetch(`/admin/products/${encodeURIComponent(sku)}`, { auth: true }),

  listUsers: (paginationToken) =>
    apiFetch("/admin/users", {
      auth: true,
      query: paginationToken ? { paginationToken } : undefined,
    }),
  setUserGroup: (username, groupName, action) =>
    apiFetch(`/admin/users/${encodeURIComponent(username)}/group`, {
      method: "POST",
      auth: true,
      body: { groupName, action },
    }),
  setUserEnabled: (username, enabled) =>
    apiFetch(`/admin/users/${encodeURIComponent(username)}/enabled`, {
      method: "POST",
      auth: true,
      body: { enabled },
    }),

  requestImageUpload: (filename, contentType) =>
    apiFetch("/uploads/product-image", {
      method: "POST",
      auth: true,
      body: { filename, contentType },
    }),
  uploadToS3: async (uploadUrl, file) => {
    const res = await fetch(uploadUrl, {
      method: "PUT",
      headers: { "Content-Type": file.type || "image/jpeg" },
      body: file,
    });
    if (!res.ok) {
      throw new Error(`S3 upload failed (${res.status})`);
    }
  },
};
