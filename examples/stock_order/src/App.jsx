import { useEffect, useState } from "react";
import { listen, send, setup, unlisten } from 'webmq-frontend';

setup('ws://localhost:8080/ws');

function App() {
  const [order, setOrder] = useState({ amount_eur: 123.0 });

  useEffect(() => {
    if (order.id) {
      listen(`orders.updated.${order.id}`, setOrder);
      return () => unlisten(`orders.updated.${order.id}`, setOrder);
    }
  }, [order.id]);

  return (
    <>
      {!order.id && <OrderForm value={order} onSubmit={setOrder} />}
      {order.id && <OrderStatus value={order} onChange={setOrder} />}
    </>
  );
}

function OrderForm({ value: order, onSubmit: setOrder }) {
  async function handleSubmit(event) {
    event.preventDefault();
    const actualOrder = { ...order, id: crypto.randomUUID(), status: 'Submitted' };
    send('orders.create', actualOrder);
    setOrder(actualOrder);
  }

  return (
    <form onSubmit={handleSubmit}>
      <p>
        Amount EUR:
        {' '}
        <input
          value={order.amount_eur}
          onChange={(e) => setOrder((prev) => ({ ...prev, amount_eur: e.target.value }))}
          type="number"
          autoFocus
        />
      </p>
      <p><button>Submit</button></p>
    </form>
  );
}

function OrderStatus({ value: order, onChange: setOrder }) {
  return (
    <>
      {order.status && <p>Status: {order.status}</p>}
      {order.amount_eur && <p>Amount EUR: {order.amount_eur}</p>}
      {order.fx_rate && <p>FX rate: {order.fx_rate}</p>}
      {order.amount_usd && <p>Amount USD: {order.amount_usd}</p>}
      {order.units && <p>Units: {order.units}</p>}
    </>
  );
}

export default App
