
import React, { useState, useEffect } from "react";
import * as XLSX from "xlsx";
import "./App.css";

function App() {
  const [products, setProducts] = useState([]);
  const [cart, setCart] = useState([]);
  const [employeeName, setEmployeeName] = useState("");

  useEffect(() => {
    fetch("products.json")
      .then((res) => res.json())
      .then((data) => setProducts(data));
  }, []);

  const addToCart = (product) => {
    const existing = cart.find((item) => item.id === product.id);
    if (existing) {
      setCart(
        cart.map((item) =>
          item.id === product.id
            ? { ...item, quantity: item.quantity + 1 }
            : item
        )
      );
    } else {
      setCart([...cart, { ...product, quantity: 1 }]);
    }
  };

  const exportToExcel = () => {
    const data = cart.map((item) => ({
      員工: employeeName,
      商品名稱: item.name,
      數量: item.quantity,
      單價: item.price,
      小計: item.price * item.quantity,
    }));

    const worksheet = XLSX.utils.json_to_sheet(data);
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, worksheet, "訂單");
    XLSX.writeFile(workbook, `訂單_${employeeName}.xlsx`);
  };

  return (
    <div className="container">
      <h1>WhiteWings 員工購物網站</h1>
      <input
        type="text"
        placeholder="輸入員工姓名"
        value={employeeName}
        onChange={(e) => setEmployeeName(e.target.value)}
      />
      <button onClick={exportToExcel} disabled={!employeeName || cart.length === 0}>
        匯出 Excel 訂單
      </button>

      <div className="product-grid">
        {products.map((product) => (
          <div className="product-card" key={product.id}>
            <img src={product.image} alt={product.name} />
            <h3>{product.name}</h3>
            <p>NT${product.price}</p>
            <button onClick={() => addToCart(product)}>加入購物車</button>
          </div>
        ))}
      </div>
    </div>
  );
}

export default App;
