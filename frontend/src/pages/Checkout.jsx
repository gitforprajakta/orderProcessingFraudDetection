import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";

import { useCart } from "../cart/CartContext.jsx";
import { ordersApi } from "../api/orders.js";

const COUNTRIES = [
  { code: "US", label: "United States (lower risk)" },
  { code: "CA", label: "Canada (lower risk)" },
  { code: "GB", label: "United Kingdom (higher risk)" },
  { code: "IN", label: "India (higher risk)" },
  { code: "AU", label: "Australia (higher risk)" },
  { code: "JP", label: "Japan (higher risk)" },
];

export default function Checkout() {
  const { cart, refresh } = useCart();
  const navigate = useNavigate();
  const [country, setCountry] = useState("US");
  const [postal, setPostal] = useState("95112");
  const [currency, setCurrency] = useState("USD");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    refresh();
  }, [refresh]);

  const items = cart.items || [];
  if (items.length === 0) {
    return (
      <div className="container">
        <div className="empty-state">
          <h2>Your cart is empty</h2>
          <Link to="/" className="primary-btn">
            Browse products
          </Link>
        </div>
      </div>
    );
  }

  const placeOrder = async (e) => {
    e.preventDefault();
    setError("");
    setBusy(true);
    try {
      const payload = {
        items: items.map((it) => ({ sku: it.sku, qty: it.qty })),
        currency,
        shippingPostal: postal,
        shippingCountry: country,
      };
      const result = await ordersApi.place(payload);
      navigate(`/my-orders/${result.orderId}`, {
        state: { freshlyPlaced: true },
      });
    } catch (err) {
      setError(err.message || "Order placement failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="container two-col">
      <section>
        <h1>Checkout</h1>
        <form onSubmit={placeOrder} className="form">
          <h2>Shipping</h2>
          <div className="grid-2">
            <label>
              Country
              <select
                value={country}
                onChange={(e) => setCountry(e.target.value)}
              >
                {COUNTRIES.map((c) => (
                  <option key={c.code} value={c.code}>
                    {c.label}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Postal code
              <input
                value={postal}
                onChange={(e) => setPostal(e.target.value)}
                required
              />
            </label>
          </div>
          <label>
            Currency
            <select
              value={currency}
              onChange={(e) => setCurrency(e.target.value)}
            >
              <option value="USD">USD</option>
              <option value="CAD">CAD</option>
              <option value="GBP">GBP</option>
              <option value="INR">INR</option>
            </select>
          </label>

          <h2>Payment</h2>
          <p className="muted">
            This demo skips real payment — orders are placed and run through the
            fraud-detection pipeline regardless.
          </p>

          {error && <div className="alert error">{error}</div>}

          <button className="primary-btn large" type="submit" disabled={busy}>
            {busy ? "Placing order…" : `Place order · $${Number(
              cart.subtotal || 0
            ).toFixed(2)}`}
          </button>
        </form>
      </section>

      <aside className="checkout-summary">
        <h2>Order summary</h2>
        {items.map((it) => (
          <div className="checkout-item" key={it.sku}>
            <img src={it.imageUrl} alt={it.name} />
            <div>
              <strong>{it.name}</strong>
              <small>
                {it.qty} × ${Number(it.unitPrice).toFixed(2)}
              </small>
            </div>
            <span>${Number(it.lineTotal).toFixed(2)}</span>
          </div>
        ))}
        <div className="summary-total">
          <span>Total</span>
          <strong>${Number(cart.subtotal || 0).toFixed(2)}</strong>
        </div>
      </aside>
    </div>
  );
}
