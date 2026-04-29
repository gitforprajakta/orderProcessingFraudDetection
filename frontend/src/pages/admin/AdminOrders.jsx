import { useEffect, useState } from "react";
import { adminApi } from "../../api/admin.js";

const STATUS_CLASS = {
  PENDING: "warning",
  REVIEW: "warning",
  APPROVE: "ok",
  BLOCK: "danger",
};

const STATUSES = ["", "PENDING", "REVIEW", "APPROVE", "BLOCK"];

function formatDate(ms) {
  if (!ms) return "—";
  return new Date(Number(ms)).toLocaleString();
}

export default function AdminOrders() {
  const [orders, setOrders] = useState([]);
  const [status, setStatus] = useState("REVIEW");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [busyOrderId, setBusyOrderId] = useState(null);

  const load = async () => {
    setLoading(true);
    try {
      const data = await adminApi.listOrders(status || undefined);
      setOrders(data.orders || []);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
  }, [status]);

  const decide = async (orderId, decision) => {
    setError("");
    setBusyOrderId(orderId);
    try {
      await adminApi.decideOrder(orderId, decision);
      await load();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusyOrderId(null);
    }
  };

  return (
    <section>
      <div className="row-between">
        <h2>Orders</h2>
        <label>
          Filter by status:&nbsp;
          <select value={status} onChange={(e) => setStatus(e.target.value)}>
            {STATUSES.map((s) => (
              <option key={s} value={s}>
                {s || "All"}
              </option>
            ))}
          </select>
        </label>
      </div>

      {error && <div className="alert error">{error}</div>}
      {loading ? (
        <div className="loading">Loading…</div>
      ) : orders.length === 0 ? (
        <div className="empty-state">
          <p>No orders match this filter.</p>
        </div>
      ) : (
        <table className="data-table">
          <thead>
            <tr>
              <th>Order</th>
              <th>User</th>
              <th>Placed</th>
              <th>Total</th>
              <th>Status</th>
              <th>Score</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {orders.map((o) => (
              <tr key={o.orderId}>
                <td className="mono">{o.orderId.slice(0, 8)}…</td>
                <td>{o.userEmail || o.userId?.slice(0, 8) || "—"}</td>
                <td>{formatDate(o.createdAt)}</td>
                <td>${Number(o.orderTotal || 0).toFixed(2)}</td>
                <td>
                  <span
                    className={`badge ${STATUS_CLASS[o.status] || "neutral"}`}
                  >
                    {o.status}
                  </span>
                </td>
                <td>
                  {o.fraudScore !== undefined
                    ? Number(o.fraudScore).toFixed(2)
                    : "—"}
                </td>
                <td>
                  {o.status === "REVIEW" ? (
                    <>
                      <button
                        className="link-btn ok"
                        onClick={() => decide(o.orderId, "APPROVE")}
                        disabled={busyOrderId === o.orderId}
                      >
                        Approve
                      </button>
                      {" · "}
                      <button
                        className="link-btn danger"
                        onClick={() => decide(o.orderId, "BLOCK")}
                        disabled={busyOrderId === o.orderId}
                      >
                        Block
                      </button>
                    </>
                  ) : (
                    <span className="muted">—</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
