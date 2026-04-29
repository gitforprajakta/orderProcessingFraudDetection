import { useEffect, useRef, useState } from "react";
import { Link, useLocation, useParams } from "react-router-dom";
import { ordersApi } from "../api/orders.js";

const STATUS_CLASS = {
  PENDING: "warning",
  REVIEW: "warning",
  APPROVE: "ok",
  BLOCK: "danger",
};

export default function OrderDetail() {
  const { orderId } = useParams();
  const location = useLocation();
  const freshlyPlaced = !!location.state?.freshlyPlaced;
  const [order, setOrder] = useState(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const pollRef = useRef(null);

  useEffect(() => {
    let alive = true;
    let attempts = 0;

    async function fetchOnce() {
      try {
        const data = await ordersApi.myGet(orderId);
        if (!alive) return;
        setOrder(data);
        if (data.status && data.status !== "PENDING") {
          if (pollRef.current) {
            clearInterval(pollRef.current);
            pollRef.current = null;
          }
        }
      } catch (e) {
        if (!alive) return;
        setError(e.message);
      } finally {
        if (alive) setLoading(false);
      }
    }

    fetchOnce();
    pollRef.current = setInterval(() => {
      attempts += 1;
      fetchOnce();
      if (attempts > 30 && pollRef.current) {
        clearInterval(pollRef.current);
        pollRef.current = null;
      }
    }, 2000);

    return () => {
      alive = false;
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, [orderId]);

  if (loading) return <div className="loading">Loading order…</div>;
  if (error) return <div className="alert error">{error}</div>;
  if (!order) return null;

  const status = order.status || "PENDING";
  const score =
    order.fraudScore !== undefined ? Number(order.fraudScore) : null;

  return (
    <div className="container">
      <Link className="back-link" to="/my-orders">
        ← Back to my orders
      </Link>
      <div className="order-detail">
        <div className="order-header">
          <h1>Order {order.orderId.slice(0, 8)}…</h1>
          <span className={`badge large ${STATUS_CLASS[status] || "neutral"}`}>
            {status}
          </span>
        </div>

        {freshlyPlaced && status === "PENDING" && (
          <div className="alert info">
            Order received. Fraud detection is running — this page will update
            automatically when the decision is in (usually under 5 seconds).
          </div>
        )}

        <section className="card">
          <h2>Items</h2>
          {(order.items || []).map((it) => (
            <div className="line-item" key={it.sku}>
              <div>
                <strong>{it.name || it.sku}</strong>
                <small>SKU {it.sku}</small>
              </div>
              <span>
                {it.qty} × ${Number(it.unitPrice).toFixed(2)}
              </span>
              <strong>
                ${(Number(it.unitPrice) * Number(it.qty)).toFixed(2)}
              </strong>
            </div>
          ))}
          <div className="line-total">
            <span>Total</span>
            <strong>${Number(order.orderTotal || 0).toFixed(2)}</strong>
          </div>
        </section>

        <section className="card">
          <h2>Shipping</h2>
          <p>
            {order.shippingCountry} · {order.shippingPostal}
          </p>
        </section>

        <section className="card">
          <h2>Fraud detection</h2>
          {score === null ? (
            <p className="muted">Awaiting decision from Fraud Lambda…</p>
          ) : (
            <ul className="kv">
              <li>
                <span>Score</span>
                <strong>{score.toFixed(3)}</strong>
              </li>
              <li>
                <span>Decision</span>
                <strong>{order.fraudDecision || status}</strong>
              </li>
              <li>
                <span>Model version</span>
                <strong>{order.fraudModelVersion || "—"}</strong>
              </li>
              {order.adminOverride && (
                <li>
                  <span>Manual override by</span>
                  <strong>{order.adminEmail || "admin"}</strong>
                </li>
              )}
            </ul>
          )}
        </section>
      </div>
    </div>
  );
}
