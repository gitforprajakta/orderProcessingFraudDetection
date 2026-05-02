import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { adminApi } from "../../api/admin.js";
import { productsApi } from "../../api/products.js";

export default function AdminInventory() {
  const [products, setProducts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [info, setInfo] = useState("");
  const [busySku, setBusySku] = useState(null);
  const [search, setSearch] = useState("");
  const [showInactive, setShowInactive] = useState(false);

  const load = async () => {
    setLoading(true);
    setError("");
    try {
      // Prefer the admin endpoint (returns archived products too).
      const data = await adminApi.listProducts();
      setProducts(data.products || []);
    } catch (adminErr) {
      // The new /admin/products route may not be deployed yet — fall back
      // to the public catalog so the Inventory tab still renders.
      try {
        const fallback = await productsApi.list();
        setProducts(fallback.products || []);
        setError(
          "Showing only active products. Run `npx cdk deploy` to enable the archived-products view."
        );
      } catch (e) {
        setError(adminErr.message || e.message);
      }
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
  }, []);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return products.filter((p) => {
      if (!showInactive && p.active === false) return false;
      if (!q) return true;
      return (
        (p.name || "").toLowerCase().includes(q) ||
        (p.sku || "").toLowerCase().includes(q) ||
        (p.category || "").toLowerCase().includes(q)
      );
    });
  }, [products, search, showInactive]);

  const handleDelete = async (sku) => {
    if (!confirm(`Soft-delete ${sku}? It will be hidden from the catalog.`)) {
      return;
    }
    setBusySku(sku);
    setError("");
    setInfo("");
    try {
      await productsApi.remove(sku);
      setInfo(`${sku} archived.`);
      await load();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusySku(null);
    }
  };

  const handleRestore = async (sku) => {
    setBusySku(sku);
    setError("");
    setInfo("");
    try {
      await productsApi.update(sku, { active: true });
      setInfo(`${sku} restored.`);
      await load();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusySku(null);
    }
  };

  return (
    <section>
      <div className="row-between">
        <h2>Inventory</h2>
        <Link to="/admin/inventory/new" className="primary-btn small">
          + New product
        </Link>
      </div>

      <div className="toolbar">
        <input
          className="search"
          placeholder="Search by name, SKU, or category…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <label className="checkbox-inline">
          <input
            type="checkbox"
            checked={showInactive}
            onChange={(e) => setShowInactive(e.target.checked)}
          />{" "}
          Show archived
        </label>
      </div>

      {info && <div className="alert success">{info}</div>}
      {error && <div className="alert error">{error}</div>}
      {loading ? (
        <div className="loading">Loading…</div>
      ) : filtered.length === 0 ? (
        <div className="empty-state">
          <p>No products match your filter.</p>
        </div>
      ) : (
        <table className="data-table">
          <thead>
            <tr>
              <th>SKU</th>
              <th>Name</th>
              <th>Category</th>
              <th>Price</th>
              <th>Stock</th>
              <th>Status</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((p) => {
              const active = p.active !== false;
              return (
                <tr key={p.sku} className={active ? "" : "row-inactive"}>
                  <td className="mono">{p.sku}</td>
                  <td>{p.name}</td>
                  <td>{p.category}</td>
                  <td>${Number(p.price).toFixed(2)}</td>
                  <td>
                    <span
                      className={
                        Number(p.stock) === 0
                          ? "text-danger"
                          : Number(p.stock) <= 5
                          ? "text-warning"
                          : ""
                      }
                    >
                      {p.stock}
                    </span>
                  </td>
                  <td>
                    <span className={`badge ${active ? "ok" : "neutral"}`}>
                      {active ? "active" : "archived"}
                    </span>
                  </td>
                  <td>
                    <Link to={`/admin/inventory/${encodeURIComponent(p.sku)}`}>
                      Edit
                    </Link>{" "}
                    {active ? (
                      <>
                        ·{" "}
                        <button
                          className="link-btn danger"
                          onClick={() => handleDelete(p.sku)}
                          disabled={busySku === p.sku}
                        >
                          Delete
                        </button>
                      </>
                    ) : (
                      <>
                        ·{" "}
                        <button
                          className="link-btn ok"
                          onClick={() => handleRestore(p.sku)}
                          disabled={busySku === p.sku}
                        >
                          Restore
                        </button>
                      </>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </section>
  );
}
