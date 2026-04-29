import { useEffect, useState } from "react";
import { adminApi } from "../../api/admin.js";

function formatDate(ms) {
  if (!ms) return "—";
  return new Date(Number(ms)).toLocaleString();
}

export default function AdminReviewQueue() {
  const [messages, setMessages] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [busyId, setBusyId] = useState(null);
  const [info, setInfo] = useState("");

  const load = async () => {
    setLoading(true);
    setError("");
    try {
      const data = await adminApi.listReviewQueue();
      setMessages(data.messages || []);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
  }, []);

  const decide = async (msg, decision) => {
    if (!msg.orderId) return;
    setError("");
    setInfo("");
    setBusyId(msg.messageId);
    try {
      await adminApi.decideOrder(msg.orderId, decision, msg.receiptHandle);
      setInfo(
        `Order ${msg.orderId.slice(0, 8)}… ${decision}d, removed from SQS.`
      );
      await load();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusyId(null);
    }
  };

  return (
    <section>
      <div className="row-between">
        <h2>Review Queue (SQS)</h2>
        <button className="link-btn" onClick={load} disabled={loading}>
          {loading ? "Refreshing…" : "Refresh"}
        </button>
      </div>

      <p className="muted" style={{ marginTop: 0 }}>
        Orders flagged <b>REVIEW</b> by the fraud model are pushed onto the
        <code> OrderReviewQueue </code> SQS queue. Admins receive an SNS email
        for every queued order. Approving or blocking here also deletes the
        message from SQS and emits another SNS notification.
      </p>

      {info && <div className="alert">{info}</div>}
      {error && <div className="alert error">{error}</div>}

      {loading ? (
        <div className="loading">Loading…</div>
      ) : messages.length === 0 ? (
        <div className="empty-state">
          <p>No orders waiting in the review queue.</p>
        </div>
      ) : (
        <table className="data-table">
          <thead>
            <tr>
              <th>Order</th>
              <th>User</th>
              <th>Placed</th>
              <th>Total</th>
              <th>Score</th>
              <th>Queued</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {messages.map((m) => {
              const o = m.order || {};
              return (
                <tr key={m.messageId}>
                  <td className="mono">
                    {(m.orderId || "").slice(0, 8)}…
                  </td>
                  <td>
                    {o.userEmail || (o.userId || "").slice(0, 8) || "—"}
                  </td>
                  <td>{formatDate(o.createdAt)}</td>
                  <td>${Number(o.orderTotal || 0).toFixed(2)}</td>
                  <td>
                    {m.score !== undefined && m.score !== null
                      ? Number(m.score).toFixed(2)
                      : "—"}
                  </td>
                  <td>{formatDate(m.evaluatedAt)}</td>
                  <td>
                    <button
                      className="link-btn ok"
                      onClick={() => decide(m, "APPROVE")}
                      disabled={busyId === m.messageId}
                    >
                      Approve
                    </button>
                    {" · "}
                    <button
                      className="link-btn danger"
                      onClick={() => decide(m, "BLOCK")}
                      disabled={busyId === m.messageId}
                    >
                      Block
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </section>
  );
}
