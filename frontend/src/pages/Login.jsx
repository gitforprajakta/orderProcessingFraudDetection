import { useState } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { useAuth } from "../auth/AuthContext.jsx";

export default function Login() {
  const { signIn } = useAuth();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const navigate = useNavigate();
  const location = useLocation();
  const from = location.state?.from || "/";

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
      <p className="muted">Sign in with your email and password.</p>
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
          {busy ? "Signing in…" : "Sign in"}
        </button>
      </form>
      <div className="auth-footer">
        <Link to="/forgot">Forgot password?</Link>
        <span>
          New here? <Link to="/signup">Create an account</Link>
        </span>
      </div>
    </div>
  );
}
