import { NavLink, Outlet } from "react-router-dom";

export default function AdminLayout() {
  return (
    <div className="container">
      <h1>Admin console</h1>
      <nav className="tabs">
        <NavLink to="/admin/dashboard" className="tab">
          Dashboard
        </NavLink>
        <NavLink to="/admin/inventory" className="tab">
          Inventory
        </NavLink>
        <NavLink to="/admin/orders" className="tab">
          Orders
        </NavLink>
        <NavLink to="/admin/review-queue" className="tab">
          Review Queue
        </NavLink>
        <NavLink to="/admin/users" className="tab">
          Users
        </NavLink>
      </nav>
      <Outlet />
    </div>
  );
}
