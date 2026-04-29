import { useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";

import { productsApi } from "../api/products.js";
import { useAuth } from "../auth/AuthContext.jsx";
import { useCart } from "../cart/CartContext.jsx";

export default function ProductDetail() {
  const { sku } = useParams();
  const [product, setProduct] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [qty, setQty] = useState(1);
  const [adding, setAdding] = useState(false);
  const { user } = useAuth();
  const { addItem } = useCart();
  const navigate = useNavigate();

  useEffect(() => {
    let alive = true;
    setLoading(true);
    productsApi
      .get(sku)
      .then((data) => alive && setProduct(data))
      .catch((e) => alive && setError(e.message))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, [sku]);

  const handleAdd = async () => {
    if (!user) {
      navigate("/login", { state: { from: `/products/${sku}` } });
      return;
    }
    try {
      setAdding(true);
      await addItem(product.sku, qty);
      navigate("/cart");
    } catch (e) {
      setError(e.message);
    } finally {
      setAdding(false);
    }
  };

  if (loading) return <div className="loading">Loading product…</div>;
  if (error) return <div className="alert error">{error}</div>;
  if (!product) return null;

  const outOfStock = (product.stock ?? 0) <= 0;

  return (
    <div className="container">
      <Link className="back-link" to="/">
        ← Back to catalog
      </Link>
      <div className="product-detail">
        <div className="product-detail-image">
          <img src={product.imageUrl} alt={product.name} />
        </div>
        <div className="product-detail-body">
          <span className="product-category">{product.category}</span>
          <h1>{product.name}</h1>
          <p className="product-sku">SKU: {product.sku}</p>
          <p className="product-description">{product.description}</p>
          <div className="product-detail-price">
            ${Number(product.price).toFixed(2)}
          </div>
          <div className="product-detail-stock">
            {outOfStock ? (
              <span className="badge danger">Out of stock</span>
            ) : (
              <span className="badge ok">{product.stock} in stock</span>
            )}
          </div>
          <div className="qty-row">
            <label>
              Quantity
              <input
                type="number"
                min={1}
                max={product.stock || 1}
                value={qty}
                onChange={(e) =>
                  setQty(Math.max(1, Number(e.target.value) || 1))
                }
                className="input"
              />
            </label>
            <button
              className="primary-btn"
              disabled={outOfStock || adding}
              onClick={handleAdd}
            >
              {adding ? "Adding…" : "Add to cart"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
