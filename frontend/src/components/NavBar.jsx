import { Link, NavLink, useNavigate } from "react-router-dom";
import { useAuth } from "../auth/AuthContext.jsx";
import { useCart } from "../cart/CartContext.jsx";

export default function NavBar() {
  const { user, isAdmin, signOut, loading } = useAuth();
  const { itemCount } = useCart();
  const navigate = useNavigate();

  const handleSignOut = async () => {
    await signOut();
    navigate("/");
  };

  return (
    <header className="navbar">
      <Link to="/" className="brand">
        <span className="brand-mark">N</span>
        <span className="brand-name">NimbusMart</span>
      </Link>

      <nav className="nav-links">
        <NavLink to="/" end>
          Catalog
        </NavLink>
        {user && <NavLink to="/my-orders">My Orders</NavLink>}
        {isAdmin && <NavLink to="/admin">Admin</NavLink>}
      </nav>

      <div className="nav-actions">
        {user && (
          <Link to="/cart" className="cart-link" aria-label="Cart">
            Cart
            {itemCount > 0 && <span className="cart-badge">{itemCount}</span>}
          </Link>
        )}
        {loading ? null : user ? (
          <div className="user-menu">
            <span className="user-email" title={user.email}>
              {user.email}
            </span>
            <button className="link-btn" onClick={handleSignOut}>
              Sign out
            </button>
          </div>
        ) : (
          <div className="auth-buttons">
            <Link className="link-btn" to="/login">
              Log in
            </Link>
            <Link className="primary-btn small" to="/signup">
              Sign up
            </Link>
          </div>
        )}
      </div>
    </header>
  );
}
