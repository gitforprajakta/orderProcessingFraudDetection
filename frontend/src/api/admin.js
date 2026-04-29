import { apiFetch } from "./client.js";

export const adminApi = {
  listOrders: (status) =>
    apiFetch("/admin/orders", {
      auth: true,
      query: status ? { status } : undefined,
    }),
  decideOrder: (orderId, decision) =>
    apiFetch(
      `/admin/orders/${encodeURIComponent(orderId)}/decision`,
      { method: "POST", auth: true, body: { decision } }
    ),
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
