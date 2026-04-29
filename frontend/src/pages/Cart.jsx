import { Link, useNavigate } from "react-router-dom";
import { useCart } from "../cart/CartContext.jsx";

export default function Cart() {
  const { cart, setItem, removeItem, clear, loading } = useCart();
  const navigate = useNavigate();

  if (loading) return <div className="loading">Loading cart…</div>;

  const items = cart.items || [];
  if (items.length === 0) {
    return (
      <div className="container">
        <div className="empty-state">
          <h2>Your cart is empty</h2>
          <p>Browse the catalog and add a few items.</p>
          <Link to="/" className="primary-btn">
            Go shopping
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="container">
      <h1>Your cart</h1>
      <div className="cart-table">
        {items.map((it) => (
          <div className="cart-row" key={it.sku}>
            <img src={it.imageUrl} alt={it.name} className="cart-thumb" />
            <div className="cart-row-info">
              <Link to={`/products/${encodeURIComponent(it.sku)}`}>
                {it.name}
              </Link>
              <small>SKU: {it.sku}</small>
              <small>${Number(it.unitPrice).toFixed(2)} each</small>
            </div>
            <div className="cart-row-qty">
              <input
                type="number"
                min={1}
                max={it.stock}
                value={it.qty}
                onChange={(e) =>
                  setItem(
                    it.sku,
                    Math.max(1, Math.min(it.stock, Number(e.target.value) || 1))
                  )
                }
                className="input"
              />
            </div>
            <div className="cart-row-line">
              ${Number(it.lineTotal).toFixed(2)}
            </div>
            <button className="link-btn" onClick={() => removeItem(it.sku)}>
              Remove
            </button>
          </div>
        ))}
      </div>

      <div className="cart-summary">
        <div>
          <span>Subtotal</span>
          <strong>${Number(cart.subtotal || 0).toFixed(2)}</strong>
        </div>
        <div className="cart-actions">
          <button className="link-btn" onClick={clear}>
            Clear cart
          </button>
          <button
            className="primary-btn"
            onClick={() => navigate("/checkout")}
          >
            Proceed to checkout
          </button>
        </div>
      </div>
    </div>
  );
}
