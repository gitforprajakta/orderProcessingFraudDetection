import { Link } from "react-router-dom";

export default function ProductCard({ product, onAdd, addingDisabled }) {
  const lowStock = (product.stock ?? 0) > 0 && (product.stock ?? 0) <= 5;
  const outOfStock = (product.stock ?? 0) <= 0;
  return (
    <article className="product-card">
      <Link
        to={`/products/${encodeURIComponent(product.sku)}`}
        className="product-thumb"
      >
        <img
          src={product.imageUrl}
          alt={product.name}
          loading="lazy"
          onError={(e) => {
            e.currentTarget.src =
              "data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='400' height='300'><rect width='100%' height='100%' fill='%23f1f5f9'/><text x='50%' y='50%' text-anchor='middle' fill='%2364748b' font-family='sans-serif'>No image</text></svg>";
          }}
        />
      </Link>
      <div className="product-body">
        <span className="product-category">{product.category}</span>
        <Link
          to={`/products/${encodeURIComponent(product.sku)}`}
          className="product-name"
        >
          {product.name}
        </Link>
        <div className="product-row">
          <span className="product-price">
            ${Number(product.price).toFixed(2)}
          </span>
          {outOfStock ? (
            <span className="badge danger">Out of stock</span>
          ) : lowStock ? (
            <span className="badge warning">Only {product.stock} left</span>
          ) : (
            <span className="badge ok">In stock</span>
          )}
        </div>
        <button
          className="primary-btn"
          disabled={outOfStock || addingDisabled}
          onClick={() => onAdd?.(product)}
        >
          {outOfStock ? "Unavailable" : "Add to cart"}
        </button>
      </div>
    </article>
  );
}
