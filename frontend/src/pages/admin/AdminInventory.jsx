import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { productsApi } from "../../api/products.js";

export default function AdminInventory() {
  const [products, setProducts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [busySku, setBusySku] = useState(null);

  const load = async () => {
    setLoading(true);
    try {
      const data = await productsApi.list();
      setProducts(data.products || []);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
  }, []);

  const handleDelete = async (sku) => {
    if (!confirm(`Soft-delete ${sku}? It will be hidden from the catalog.`)) {
      return;
    }
    setBusySku(sku);
    try {
      await productsApi.remove(sku);
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
      {error && <div className="alert error">{error}</div>}
      {loading ? (
        <div className="loading">Loading…</div>
      ) : (
        <table className="data-table">
          <thead>
            <tr>
              <th>SKU</th>
              <th>Name</th>
              <th>Category</th>
              <th>Price</th>
              <th>Stock</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {products.map((p) => (
              <tr key={p.sku}>
                <td className="mono">{p.sku}</td>
                <td>{p.name}</td>
                <td>{p.category}</td>
                <td>${Number(p.price).toFixed(2)}</td>
                <td>{p.stock}</td>
                <td>
                  <Link to={`/admin/inventory/${encodeURIComponent(p.sku)}`}>
                    Edit
                  </Link>{" "}
                  ·{" "}
                  <button
                    className="link-btn danger"
                    onClick={() => handleDelete(p.sku)}
                    disabled={busySku === p.sku}
                  >
                    Delete
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
