import { useState } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { useAuth } from "../auth/AuthContext.jsx";

const ROLE_CUSTOMER = "customer";
const ROLE_ADMIN = "admin";

export default function Login() {
  const { signIn, signOut, refresh } = useAuth();
  const [role, setRole] = useState(ROLE_CUSTOMER);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const navigate = useNavigate();
  const location = useLocation();

  const isAdminTab = role === ROLE_ADMIN;
  const fallbackTarget = isAdminTab ? "/admin" : "/";
  const from = location.state?.from || fallbackTarget;

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError("");
    setBusy(true);
    try {
      const res = await signIn(email, password);

      if (
        res?.nextStep?.signInStep === "CONFIRM_SIGN_UP" ||
        res?.nextStep?.signInStep === "CONFIRM_SIGN_UP_WITH_NEW_PASSWORD_REQUIRED"
      ) {
        navigate("/verify", { state: { email } });
        return;
      }

      const refreshed = await refresh();
      const groups = refreshed?.groups || [];
      const isAdmin = groups.includes("admins");

      if (isAdminTab && !isAdmin) {
        await signOut();
        setError(
          "This account is not an administrator. Use the Customer tab to sign in, or contact an admin to grant access."
        );
        return;
      }

      if (!isAdminTab && isAdmin) {
        navigate("/admin", { replace: true });
        return;
      }

      navigate(from, { replace: true });
    } catch (err) {
      if (err?.name === "UserNotConfirmedException") {
        navigate("/verify", { state: { email } });
        return;
      }
      setError(err.message || "Sign-in failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="auth-card">
      <h1>Welcome back</h1>
      <p className="muted">
        {isAdminTab
          ? "Sign in with your administrator account."
          : "Sign in to shop, view orders, and manage your cart."}
      </p>

      <div className="role-tabs" role="tablist" aria-label="Login role">
        <button
          type="button"
          role="tab"
          aria-selected={!isAdminTab}
          className={`role-tab ${!isAdminTab ? "active" : ""}`}
          onClick={() => {
            setRole(ROLE_CUSTOMER);
            setError("");
          }}
        >
          Customer
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={isAdminTab}
          className={`role-tab ${isAdminTab ? "active" : ""}`}
          onClick={() => {
            setRole(ROLE_ADMIN);
            setError("");
          }}
        >
          Administrator
        </button>
      </div>

      <form onSubmit={handleSubmit} className="form">
        <label>
          Email
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            autoComplete="email"
            required
          />
        </label>
        <label>
          Password
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="current-password"
            required
          />
        </label>
        {error && <div className="alert error">{error}</div>}
        <button className="primary-btn" type="submit" disabled={busy}>
          {busy
            ? "Signing in…"
            : isAdminTab
            ? "Sign in as admin"
            : "Sign in"}
        </button>
      </form>

      <div className="auth-footer">
        <Link to="/forgot">Forgot password?</Link>
        {!isAdminTab && (
          <span>
            New here? <Link to="/signup">Create an account</Link>
          </span>
        )}
        {isAdminTab && (
          <span className="muted">
            Admin accounts are provisioned by another admin.
          </span>
        )}
      </div>
    </div>
  );
}
