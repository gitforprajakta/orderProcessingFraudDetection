import { Link } from "react-router-dom";
import ProductImage from "./ProductImage.jsx";

export default function ProductCard({ product, onAdd, addingDisabled }) {
  const lowStock = (product.stock ?? 0) > 0 && (product.stock ?? 0) <= 5;
  const outOfStock = (product.stock ?? 0) <= 0;

  return (
    <article className="product-card">
      <Link
        to={`/products/${encodeURIComponent(product.sku)}`}
        className="product-thumb"
      >
        <ProductImage url={product.imageUrl} alt={product.name} />
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
