import { Link } from "react-router-dom";

export default function NotFound() {
  return (
    <div className="empty-state">
      <h1>404</h1>
      <p>That page does not exist.</p>
      <Link className="primary-btn" to="/">
        Back to catalog
      </Link>
    </div>
  );
}
