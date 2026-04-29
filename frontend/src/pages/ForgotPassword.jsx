import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useAuth } from "../auth/AuthContext.jsx";

export default function ForgotPassword() {
  const { forgotPassword, confirmForgotPassword } = useAuth();
  const [step, setStep] = useState(1);
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const navigate = useNavigate();

  const requestCode = async (e) => {
    e.preventDefault();
    setError("");
    setBusy(true);
    try {
      await forgotPassword(email);
      setStep(2);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  const submitNew = async (e) => {
    e.preventDefault();
    setError("");
    setBusy(true);
    try {
      await confirmForgotPassword(email, code, newPassword);
      navigate("/login", { state: { email } });
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="auth-card">
      <h1>Reset your password</h1>
      {step === 1 ? (
        <form onSubmit={requestCode} className="form">
          <label>
            Email
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
            />
          </label>
          {error && <div className="alert error">{error}</div>}
          <button className="primary-btn" disabled={busy} type="submit">
            {busy ? "Sending…" : "Send reset code"}
          </button>
        </form>
      ) : (
        <form onSubmit={submitNew} className="form">
          <p className="muted">
            Code sent to <strong>{email}</strong>.
          </p>
          <label>
            Verification code
            <input
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))}
              maxLength={6}
              required
            />
          </label>
          <label>
            New password
            <input
              type="password"
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              minLength={8}
              required
            />
          </label>
          {error && <div className="alert error">{error}</div>}
          <button className="primary-btn" disabled={busy} type="submit">
            {busy ? "Updating…" : "Set new password"}
          </button>
        </form>
      )}
      <div className="auth-footer">
        <Link to="/login">Back to sign in</Link>
      </div>
    </div>
  );
}
