import { createContext, useCallback, useContext, useEffect, useState } from "react";
import { cartApi } from "../api/cart.js";
import { useAuth } from "../auth/AuthContext.jsx";

const CartContext = createContext(null);

export function CartProvider({ children }) {
  const { user } = useAuth();
  const [cart, setCart] = useState({ items: [], subtotal: 0 });
  const [loading, setLoading] = useState(false);

  const refresh = useCallback(async () => {
    if (!user) {
      setCart({ items: [], subtotal: 0 });
      return;
    }
    setLoading(true);
    try {
      const data = await cartApi.get();
      setCart(data);
    } catch {
      setCart({ items: [], subtotal: 0 });
    } finally {
      setLoading(false);
    }
  }, [user]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const addItem = async (sku, qty = 1) => {
    const data = await cartApi.addItem(sku, qty);
    setCart(data);
  };
  const setItem = async (sku, qty) => {
    const data = await cartApi.setItem(sku, qty);
    setCart(data);
  };
  const removeItem = async (sku) => {
    const data = await cartApi.removeItem(sku);
    setCart(data);
  };
  const clear = async () => {
    const data = await cartApi.clear();
    setCart(data);
  };

  const itemCount = (cart.items || []).reduce(
    (sum, it) => sum + Number(it.qty || 0),
    0
  );

  return (
    <CartContext.Provider
      value={{
        cart,
        loading,
        itemCount,
        refresh,
        addItem,
        setItem,
        removeItem,
        clear,
      }}
    >
      {children}
    </CartContext.Provider>
  );
}

export function useCart() {
  const ctx = useContext(CartContext);
  if (!ctx) throw new Error("useCart must be used inside <CartProvider>");
  return ctx;
}


// creating a PR
