import { useEffect, useState } from "react";
import { adminApi } from "../../api/admin.js";
import { useAuth } from "../../auth/AuthContext.jsx";

function formatDate(iso) {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

export default function AdminUsers() {
  const { user: me } = useAuth();
  const [users, setUsers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [info, setInfo] = useState("");
  const [busyUser, setBusyUser] = useState(null);

  const load = async () => {
    setLoading(true);
    setError("");
    try {
      const data = await adminApi.listUsers();
      setUsers(data.users || []);
    } catch (e) {
      const msg = (e && e.message) || "Failed to fetch";
      if (
        msg.toLowerCase().includes("failed to fetch") ||
        e?.status === 403 ||
        e?.status === 404 ||
        e?.status === 405
      ) {
        setError(
          "Could not reach /admin/users — this endpoint was just added. Run `npx cdk deploy` to push the new admin Lambda + API Gateway routes to AWS, then reload."
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

  const toggleAdmin = async (u) => {
    const isAdmin = u.groups.includes("admins");
    const action = isAdmin ? "remove" : "add";
    const verb = isAdmin ? "Demote" : "Promote";
    if (
      !confirm(
        `${verb} ${u.email || u.username} ${
          isAdmin ? "from" : "to"
        } the admins group?`
      )
    ) {
      return;
    }
    setError("");
    setInfo("");
    setBusyUser(u.username);
    try {
      await adminApi.setUserGroup(u.username, "admins", action);
      setInfo(
        `${u.email || u.username} ${
          isAdmin ? "removed from admins" : "promoted to admin"
        }.`
      );
      await load();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusyUser(null);
    }
  };

  const toggleEnabled = async (u) => {
    const next = !u.enabled;
    if (
      !confirm(
        `${next ? "Enable" : "Disable"} ${u.email || u.username}? ${
          next
            ? "They will be able to sign in again."
            : "They will not be able to sign in."
        }`
      )
    ) {
      return;
    }
    setError("");
    setInfo("");
    setBusyUser(u.username);
    try {
      await adminApi.setUserEnabled(u.username, next);
      setInfo(`${u.email || u.username} ${next ? "enabled" : "disabled"}.`);
      await load();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusyUser(null);
    }
  };

  return (
    <section>
      <div className="row-between">
        <h2>Users</h2>
        <button className="link-btn" onClick={load} disabled={loading}>
          {loading ? "Refreshing…" : "Refresh"}
        </button>
      </div>
      <p className="muted" style={{ marginTop: 0 }}>
        All users come from the Cognito user pool. Promote or demote admins,
        and enable/disable sign-in. You cannot modify your own account here.
      </p>

      {info && <div className="alert success">{info}</div>}
      {error && <div className="alert error">{error}</div>}

      {loading ? (
        <div className="loading">Loading…</div>
      ) : users.length === 0 ? (
        <div className="empty-state">
          <p>No users found.</p>
        </div>
      ) : (
        <table className="data-table">
          <thead>
            <tr>
              <th>Email</th>
              <th>Status</th>
              <th>Groups</th>
              <th>Created</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {users.map((u) => {
              const isMe =
                me &&
                (me.username === u.username ||
                  (me.email && me.email === u.email));
              const isAdmin = u.groups.includes("admins");
              return (
                <tr key={u.username}>
                  <td>
                    {u.email || <span className="muted">{u.username}</span>}
                    {isMe && (
                      <span className="badge neutral" style={{ marginLeft: 6 }}>
                        you
                      </span>
                    )}
                  </td>
                  <td>
                    <span
                      className={`badge ${u.enabled ? "ok" : "danger"}`}
                      style={{ marginRight: 4 }}
                    >
                      {u.enabled ? "enabled" : "disabled"}
                    </span>
                    <span className="badge neutral">{u.status}</span>
                  </td>
                  <td>
                    {u.groups.length === 0 ? (
                      <span className="muted">—</span>
                    ) : (
                      u.groups.map((g) => (
                        <span
                          key={g}
                          className={`badge ${
                            g === "admins" ? "warning" : "neutral"
                          }`}
                          style={{ marginRight: 4 }}
                        >
                          {g}
                        </span>
                      ))
                    )}
                  </td>
                  <td>{formatDate(u.createdAt)}</td>
                  <td>
                    <button
                      className="link-btn"
                      disabled={busyUser === u.username || isMe}
                      onClick={() => toggleAdmin(u)}
                      title={isMe ? "You cannot modify yourself" : ""}
                    >
                      {isAdmin ? "Demote" : "Promote to admin"}
                    </button>
                    {" · "}
                    <button
                      className={`link-btn ${u.enabled ? "danger" : "ok"}`}
                      disabled={busyUser === u.username || isMe}
                      onClick={() => toggleEnabled(u)}
                      title={isMe ? "You cannot modify yourself" : ""}
                    >
                      {u.enabled ? "Disable" : "Enable"}
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
