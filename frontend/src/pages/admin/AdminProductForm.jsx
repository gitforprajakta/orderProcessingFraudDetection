import { useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { productsApi } from "../../api/products.js";
import { adminApi } from "../../api/admin.js";
import ProductImage from "../../components/ProductImage.jsx";
import { isHeicOrHeifUrl } from "../../utils/productImage.js";

const EMPTY = {
  sku: "",
  name: "",
  description: "",
  category: "electronics",
  price: 0,
  currency: "USD",
  stock: 1,
  imageUrl: "",
};

export default function AdminProductForm() {
  const { sku } = useParams();
  const editing = Boolean(sku);
  const navigate = useNavigate();
  const [form, setForm] = useState(EMPTY);
  const [loading, setLoading] = useState(editing);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [uploading, setUploading] = useState(false);
  const [uploadInfo, setUploadInfo] = useState("");

  useEffect(() => {
    if (!editing) return;
    adminApi
      .getProduct(sku)
      .catch(() => productsApi.get(sku))
      .then((data) => setForm({ ...EMPTY, ...data }))
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, [editing, sku]);

  const update = (k, v) => setForm((f) => ({ ...f, [k]: v }));

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError("");
    setBusy(true);
    try {
      const payload = {
        sku: form.sku.trim(),
        name: form.name.trim(),
        description: form.description,
        category: form.category.trim(),
        price: Number(form.price),
        currency: form.currency,
        stock: Number(form.stock),
        imageUrl: form.imageUrl,
      };
      if (editing) {
        const { sku: _ignore, ...rest } = payload;
        await productsApi.update(sku, rest);
      } else {
        await productsApi.create(payload);
      }
      navigate("/admin/inventory");
    } catch (err) {
      setError(err.message || "Save failed");
    } finally {
      setBusy(false);
    }
  };

  const handleUpload = async (file) => {
    setError("");
    setUploadInfo("");
    const name = file.name || "";
    if (/\.(heic|heif)$/i.test(name)) {
      setError(
        "HEIC/HEIF cannot be displayed in the web catalog (browsers do not support it). Export the photo as JPEG or PNG (on iPhone: Settings → Camera → Formats → Most Compatible), then upload again."
      );
      return;
    }
    setUploading(true);
    try {
      const { uploadUrl, publicUrl } = await adminApi.requestImageUpload(
        file.name,
        file.type || "image/jpeg"
      );
      await adminApi.uploadToS3(uploadUrl, file);
      update("imageUrl", publicUrl);
      setUploadInfo(`Image uploaded to S3: ${publicUrl}`);
    } catch (err) {
      setError(`Image upload failed: ${err.message}`);
    } finally {
      setUploading(false);
    }
  };

  if (loading) return <div className="loading">Loading…</div>;

  return (
    <section>
      <Link to="/admin/inventory" className="back-link">
        ← Back to inventory
      </Link>
      <h2>{editing ? `Edit ${sku}` : "New product"}</h2>
      <form onSubmit={handleSubmit} className="form">
        <div className="grid-2">
          <label>
            SKU
            <input
              value={form.sku}
              onChange={(e) => update("sku", e.target.value)}
              disabled={editing}
              required
            />
          </label>
          <label>
            Category
            <input
              value={form.category}
              onChange={(e) => update("category", e.target.value)}
              required
            />
          </label>
        </div>
        <label>
          Name
          <input
            value={form.name}
            onChange={(e) => update("name", e.target.value)}
            required
          />
        </label>
        <label>
          Description
          <textarea
            rows={3}
            value={form.description}
            onChange={(e) => update("description", e.target.value)}
          />
        </label>
        <div className="grid-2">
          <label>
            Price (USD)
            <input
              type="number"
              step="0.01"
              min="0"
              value={form.price}
              onChange={(e) => update("price", e.target.value)}
              required
            />
          </label>
          <label>
            Stock
            <input
              type="number"
              step="1"
              min="0"
              value={form.stock}
              onChange={(e) => update("stock", e.target.value)}
              required
            />
          </label>
        </div>

        <label>
          Image URL
          <input
            value={form.imageUrl}
            onChange={(e) => update("imageUrl", e.target.value)}
            placeholder="Paste a URL or upload below"
          />
        </label>
        <label>
          Or upload an image to S3
          <input
            type="file"
            accept="image/jpeg,image/png,image/webp,image/gif,.jpg,.jpeg,.png,.webp,.gif"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) handleUpload(file);
              e.target.value = "";
            }}
            disabled={uploading}
          />
        </label>
        <p className="hint">
          iPhone photos are often HEIC — those do not show in browsers. Use JPEG
          or PNG for catalog images.
        </p>
        {uploading && <div className="alert info">Uploading to S3…</div>}
        {uploadInfo && <div className="alert success">{uploadInfo}</div>}
        {form.imageUrl?.trim() ? (
          <div className="image-preview">
            <ProductImage url={form.imageUrl} alt="preview" loading="eager" />
            {isHeicOrHeifUrl(form.imageUrl) && (
              <div className="alert info" style={{ marginTop: 10 }}>
                This URL points to a HEIC file. Browsers cannot render it — edit
                the product and upload JPEG or PNG instead.
              </div>
            )}
          </div>
        ) : (
          <div className="hint">
            No image set. Paste a public URL or upload JPEG/PNG/WebP — HEIC
            (iPhone default) will not display on the site.
          </div>
        )}

        {error && <div className="alert error">{error}</div>}

        <button className="primary-btn" type="submit" disabled={busy}>
          {busy ? "Saving…" : editing ? "Save changes" : "Create product"}
        </button>
      </form>
    </section>
  );
}
