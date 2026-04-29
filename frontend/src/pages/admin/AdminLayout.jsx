import { NavLink, Outlet } from "react-router-dom";

export default function AdminLayout() {
  return (
    <div className="container">
      <h1>Admin</h1>
      <nav className="tabs">
        <NavLink to="/admin/inventory" className="tab">
          Inventory
        </NavLink>
        <NavLink to="/admin/orders" className="tab">
          Orders
        </NavLink>
        <NavLink to="/admin/review-queue" className="tab">
          Review Queue
        </NavLink>
      </nav>
      <Outlet />
    </div>
  );
}
