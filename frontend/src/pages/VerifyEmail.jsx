import { useState } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { useAuth } from "../auth/AuthContext.jsx";

export default function VerifyEmail() {
  const { confirmSignUp, resendCode } = useAuth();
  const location = useLocation();
  const navigate = useNavigate();
  const [email, setEmail] = useState(location.state?.email || "");
  const [code, setCode] = useState("");
  const [info, setInfo] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const handleVerify = async (e) => {
    e.preventDefault();
    setError("");
    setBusy(true);
    try {
      await confirmSignUp(email, code);
      setInfo("Verified! You can now sign in.");
      setTimeout(() => navigate("/login", { state: { email } }), 800);
    } catch (err) {
      setError(err.message || "Verification failed");
    } finally {
      setBusy(false);
    }
  };

  const handleResend = async () => {
    setError("");
    try {
      await resendCode(email);
      setInfo("New code sent. Check your inbox.");
    } catch (err) {
      setError(err.message);
    }
  };

  return (
    <div className="auth-card">
      <h1>Verify your email</h1>
      <p className="muted">Enter the 6-digit code we just emailed you.</p>
      <form onSubmit={handleVerify} className="form">
        <label>
          Email
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
          />
        </label>
        <label>
          Verification code
          <input
            inputMode="numeric"
            value={code}
            onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))}
            maxLength={6}
            required
          />
        </label>
        {info && <div className="alert success">{info}</div>}
        {error && <div className="alert error">{error}</div>}
        <button className="primary-btn" type="submit" disabled={busy}>
          {busy ? "Verifying…" : "Verify"}
        </button>
      </form>
      <div className="auth-footer">
        <button className="link-btn" onClick={handleResend} type="button">
          Resend code
        </button>
        <Link to="/login">Back to sign in</Link>
      </div>
    </div>
  );
}
