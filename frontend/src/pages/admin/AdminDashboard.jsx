import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { adminApi } from "../../api/admin.js";

const STATUS_LABEL_ORDER = ["PENDING", "REVIEW", "APPROVE", "BLOCK"];

function StatusBadge({ status, count }) {
  const cls =
    status === "APPROVE"
      ? "ok"
      : status === "BLOCK"
      ? "danger"
      : status === "REVIEW" || status === "PENDING"
      ? "warning"
      : "neutral";
  return (
    <li>
      <span className={`badge ${cls}`}>{status}</span>
      <strong>{count}</strong>
    </li>
  );
}

export default function AdminDashboard() {
  const [stats, setStats] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const load = async () => {
    setLoading(true);
    setError("");
    try {
      const data = await adminApi.stats();
      setStats(data);
    } catch (e) {
      const msg = (e && e.message) || "Failed to fetch";
      if (
        msg.toLowerCase().includes("failed to fetch") ||
        e?.status === 403 ||
        e?.status === 404 ||
        e?.status === 405
      ) {
        setError(
          "Could not reach /admin/stats — this endpoint was just added. Run `npx cdk deploy` to push the new admin Lambda + API Gateway routes to AWS, then reload."
        );
      } else {
        setError(msg);
      }
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
  }, []);

  if (loading) return <div className="loading">Loading dashboard…</div>;
  if (error) return <div className="alert error">{error}</div>;
  if (!stats) return null;

  const orderStatuses = STATUS_LABEL_ORDER.filter(
    (s) => stats.orders.byStatus?.[s] !== undefined
  );
  Object.keys(stats.orders.byStatus || {}).forEach((s) => {
    if (!orderStatuses.includes(s)) orderStatuses.push(s);
  });

  return (
    <section className="admin-dashboard">
      <div className="row-between">
        <h2>Dashboard</h2>
        <button className="link-btn" onClick={load}>
          Refresh
        </button>
      </div>

      <div className="stat-grid">
        <div className="stat-card">
          <div className="stat-label">Total orders</div>
          <div className="stat-value">{stats.orders.total}</div>
          <div className="stat-sub">
            {stats.orders.last7Days} in last 7 days
          </div>
        </div>
        <div className="stat-card">
          <div className="stat-label">Approved revenue</div>
          <div className="stat-value">
            ${Number(stats.orders.revenueApproved || 0).toFixed(2)}
          </div>
          <div className="stat-sub">
            avg order $
            {Number(stats.orders.averageApprovedOrderValue || 0).toFixed(2)}
          </div>
        </div>
        <div className="stat-card">
          <div className="stat-label">Active products</div>
          <div className="stat-value">{stats.products.active}</div>
          <div className="stat-sub">
            {stats.products.inactive} archived · {stats.products.total} total
          </div>
        </div>
        <div className="stat-card">
          <div className="stat-label">Customers / Admins</div>
          <div className="stat-value">
            {stats.users.customers} / {stats.users.admins}
          </div>
          <div className="stat-sub">Cognito group counts</div>
        </div>
      </div>

      <div className="grid-2 stat-grid-secondary">
        <div className="card">
          <h3>Orders by status</h3>
          {orderStatuses.length === 0 ? (
            <p className="muted">No orders yet.</p>
          ) : (
            <ul className="status-list">
              {orderStatuses.map((s) => (
                <StatusBadge
                  key={s}
                  status={s}
                  count={stats.orders.byStatus[s]}
                />
              ))}
            </ul>
          )}
          <p className="muted" style={{ marginTop: 12 }}>
            <Link to="/admin/orders">Go to Orders →</Link>
          </p>
        </div>

        <div className="card">
          <h3>
            Low stock{" "}
            <span className="muted" style={{ fontSize: "0.85rem" }}>
              (≤ {stats.products.lowStockThreshold})
            </span>
          </h3>
          {stats.products.lowStock.length === 0 ? (
            <p className="muted">All active products are above threshold.</p>
          ) : (
            <ul className="kv">
              {stats.products.lowStock.slice(0, 8).map((p) => (
                <li key={p.sku}>
                  <span>
                    <Link to={`/admin/inventory/${encodeURIComponent(p.sku)}`}>
                      {p.name}
                    </Link>
                  </span>
                  <strong
                    className={p.stock === 0 ? "text-danger" : "text-warning"}
                  >
                    {p.stock}
                  </strong>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </section>
  );
}
