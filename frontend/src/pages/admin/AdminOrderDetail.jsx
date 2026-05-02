import { useEffect, useState } from "react";
import { Link, useParams, useNavigate } from "react-router-dom";
import { adminApi } from "../../api/admin.js";

const STATUS_CLASS = {
  PENDING: "warning",
  REVIEW: "warning",
  APPROVE: "ok",
  BLOCK: "danger",
};

function formatDate(ms) {
  if (!ms) return "—";
  return new Date(Number(ms)).toLocaleString();
}

export default function AdminOrderDetail() {
  const { orderId } = useParams();
  const navigate = useNavigate();
  const [order, setOrder] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const load = async () => {
    setLoading(true);
    try {
      const data = await adminApi.getOrder(orderId);
      setOrder(data);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
  }, [orderId]);

  const decide = async (decision) => {
    if (!confirm(`Mark this order as ${decision}?`)) return;
    setError("");
    setBusy(true);
    try {
      await adminApi.decideOrder(orderId, decision);
      await load();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  if (loading) return <div className="loading">Loading order…</div>;
  if (error) return <div className="alert error">{error}</div>;
  if (!order) return null;

  const status = order.status || "PENDING";
  const score =
    order.fraudScore !== undefined && order.fraudScore !== null
      ? Number(order.fraudScore)
      : null;

  return (
    <section>
      <button
        type="button"
        className="back-link link-btn"
        onClick={() => navigate(-1)}
      >
        ← Back
      </button>

      <div className="order-detail">
        <div className="order-header">
          <h2>Order {order.orderId.slice(0, 8)}…</h2>
          <span className={`badge large ${STATUS_CLASS[status] || "neutral"}`}>
            {status}
          </span>
        </div>

        <section className="card">
          <h3>Customer</h3>
          <ul className="kv">
            <li>
              <span>Email</span>
              <strong>{order.userEmail || "—"}</strong>
            </li>
            <li>
              <span>User ID</span>
              <strong className="mono">{order.userId || "—"}</strong>
            </li>
            <li>
              <span>Placed</span>
              <strong>{formatDate(order.createdAt)}</strong>
            </li>
          </ul>
        </section>

        <section className="card">
          <h3>Items</h3>
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
          <h3>Shipping</h3>
          <p>
            {order.shippingCountry || "—"} · {order.shippingPostal || "—"}
          </p>
        </section>

        <section className="card">
          <h3>Fraud detection</h3>
          {score === null ? (
            <p className="muted">No decision recorded yet.</p>
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
              <li>
                <span>Evaluated at</span>
                <strong>{formatDate(order.evaluatedAt)}</strong>
              </li>
              {order.adminOverride && (
                <li>
                  <span>Admin override by</span>
                  <strong>{order.adminEmail || "admin"}</strong>
                </li>
              )}
            </ul>
          )}
        </section>

        {(status === "REVIEW" || status === "PENDING") && (
          <section className="card">
            <h3>Manual decision</h3>
            <p className="muted">
              Approving or blocking will record an admin override and emit an
              EventBridge event (which triggers an SNS email; blocks also
              restore stock).
            </p>
            <div style={{ display: "flex", gap: 12 }}>
              <button
                className="primary-btn small"
                disabled={busy}
                onClick={() => decide("APPROVE")}
              >
                Approve
              </button>
              <button
                className="primary-btn small"
                style={{ background: "#b91c1c" }}
                disabled={busy}
                onClick={() => decide("BLOCK")}
              >
                Block
              </button>
            </div>
          </section>
        )}

        <p className="muted">
          <Link to="/admin/orders">← All orders</Link>
        </p>
      </div>
    </section>
  );
}
