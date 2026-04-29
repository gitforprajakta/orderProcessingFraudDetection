import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { ordersApi } from "../api/orders.js";

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

export default function MyOrders() {
  const [orders, setOrders] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    let alive = true;
    ordersApi
      .myList()
      .then((data) => alive && setOrders(data.orders || []))
      .catch((e) => alive && setError(e.message))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, []);

  if (loading) return <div className="loading">Loading orders…</div>;

  return (
    <div className="container">
      <h1>My orders</h1>
      {error && <div className="alert error">{error}</div>}

      {orders.length === 0 ? (
        <div className="empty-state">
          <p>You haven't placed any orders yet.</p>
          <Link to="/" className="primary-btn">
            Start shopping
          </Link>
        </div>
      ) : (
        <table className="data-table">
          <thead>
            <tr>
              <th>Order</th>
              <th>Placed</th>
              <th>Items</th>
              <th>Total</th>
              <th>Status</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {orders.map((o) => (
              <tr key={o.orderId}>
                <td className="mono">{o.orderId.slice(0, 8)}…</td>
                <td>{formatDate(o.createdAt)}</td>
                <td>
                  {(o.items || []).reduce((s, it) => s + Number(it.qty), 0)}
                </td>
                <td>${Number(o.orderTotal || 0).toFixed(2)}</td>
                <td>
                  <span
                    className={`badge ${STATUS_CLASS[o.status] || "neutral"}`}
                  >
                    {o.status}
                  </span>
                </td>
                <td>
                  <Link to={`/my-orders/${o.orderId}`}>Details →</Link>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
