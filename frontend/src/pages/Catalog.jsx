import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";

import ProductCard from "../components/ProductCard.jsx";
import { productsApi } from "../api/products.js";
import { useAuth } from "../auth/AuthContext.jsx";
import { useCart } from "../cart/CartContext.jsx";

export default function Catalog() {
  const [products, setProducts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [category, setCategory] = useState("");
  const [error, setError] = useState("");
  const [adding, setAdding] = useState(null);
  const { user } = useAuth();
  const { addItem } = useCart();
  const navigate = useNavigate();

  useEffect(() => {
    let alive = true;
    setLoading(true);
    productsApi
      .list(category || undefined)
      .then((data) => {
        if (alive) setProducts(data.products || []);
      })
      .catch((e) => alive && setError(e.message))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, [category]);

  const categories = useMemo(() => {
    const set = new Set(products.map((p) => p.category).filter(Boolean));
    return Array.from(set).sort();
  }, [products]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return products;
    return products.filter(
      (p) =>
        p.name?.toLowerCase().includes(q) ||
        p.sku?.toLowerCase().includes(q) ||
        p.description?.toLowerCase().includes(q)
    );
  }, [products, search]);

  const handleAdd = async (product) => {
    if (!user) {
      navigate("/login", { state: { from: "/" } });
      return;
    }
    try {
      setAdding(product.sku);
      await addItem(product.sku, 1);
    } catch (e) {
      setError(e.message);
    } finally {
      setAdding(null);
    }
  };

  return (
    <div className="container">
      <section className="hero">
        <h1>Welcome to NimbusMart</h1>
        <p>
          Every order you place runs through a real AWS event-driven fraud
          detection pipeline — Cognito → API Gateway → Lambda → DynamoDB →
          EventBridge → XGBoost in Lambda → SNS.
        </p>
      </section>

      <div className="toolbar">
        <input
          type="search"
          placeholder="Search products"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="search"
        />
        <select
          value={category}
          onChange={(e) => setCategory(e.target.value)}
          className="select"
        >
          <option value="">All categories</option>
          {categories.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </select>
      </div>

      {error && <div className="alert error">{error}</div>}
      {loading ? (
        <div className="loading">Loading catalog…</div>
      ) : filtered.length === 0 ? (
        <div className="empty-state">
          <p>No products match.</p>
        </div>
      ) : (
        <div className="grid-products">
          {filtered.map((p) => (
            <ProductCard
              key={p.sku}
              product={p}
              onAdd={handleAdd}
              addingDisabled={adding === p.sku}
            />
          ))}
        </div>
      )}
    </div>
  );
}
